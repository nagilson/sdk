#!/usr/bin/env bash
# Updates the pre-built dotnetup executables in eng/dotnetup/ when source files change.
# Default: Builds current platform first (blocking), then other RIDs in background.
# Use --rid <rid> to build only a specific RID.
# Use --all to build all RIDs sequentially (no background jobs).

set -e

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
dotnetup_src_dir="$repo_root/src/Installer/dotnetup"
library_src_dir="$repo_root/src/Installer/Microsoft.Dotnet.Installation"
dotnetup_project="$dotnetup_src_dir/dotnetup.csproj"
output_base_dir="$script_dir/dotnetup"

all_rids=("win-x64" "win-arm64" "linux-x64" "linux-arm64" "osx-x64" "osx-arm64")

force=false
verbose=false
build_all=false
rid=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --rid) rid="$2"; shift 2 ;;
        --all) build_all=true; shift ;;
        --force) force=true; shift ;;
        --verbose) verbose=true; shift ;;
        *) shift ;;
    esac
done

# Determine current platform RID
get_current_rid() {
    if [[ "$(uname)" == "Darwin" ]]; then
        if [[ "$(uname -m)" == "arm64" ]]; then
            echo "osx-arm64"
        else
            echo "osx-x64"
        fi
    else
        if [[ "$(uname -m)" == "aarch64" ]]; then
            echo "linux-arm64"
        else
            echo "linux-x64"
        fi
    fi
}

# Compute hash of source file metadata (fast - uses timestamps, not content)
get_source_hash() {
    local hash_input=""
    
    # Get all .cs, .csproj, .resx files from both directories
    while IFS= read -r -d '' file; do
        local mtime=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null)
        local size=$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file" 2>/dev/null)
        hash_input="$hash_input$file:$mtime:$size|"
    done < <(find "$dotnetup_src_dir" "$library_src_dir" -type f \( -name "*.cs" -o -name "*.csproj" -o -name "*.resx" \) -print0 2>/dev/null | sort -z)
    
    if [[ -z "$hash_input" ]]; then
        echo ""
        return
    fi
    
    echo -n "$hash_input" | sha256sum | cut -d' ' -f1
}

# Build for a single RID
build_dotnetup_for_rid() {
    local target_rid="$1"
    local output_dir="$output_base_dir/$target_rid"
    local hash_file="$output_dir/.sourcehash"
    local exe_name="dotnetup"
    if [[ "$target_rid" == win-* ]]; then
        exe_name="dotnetup.exe"
    fi
    local exe_path="$output_dir/$exe_name"
    
    local current_hash=$(get_source_hash)
    local stored_hash=""
    if [[ -f "$hash_file" ]]; then
        stored_hash=$(cat "$hash_file")
    fi
    
    local needs_rebuild=false
    if [[ "$force" == "true" ]]; then
        needs_rebuild=true
    elif [[ ! -f "$exe_path" ]]; then
        needs_rebuild=true
    elif [[ "$current_hash" != "$stored_hash" ]]; then
        needs_rebuild=true
    fi
    
    if [[ "$needs_rebuild" != "true" ]]; then
        if [[ "$verbose" == "true" ]]; then
            echo "dotnetup ($target_rid) is up to date."
        fi
        return 0
    fi
    
    if [[ "$verbose" == "true" ]]; then
        echo "Building dotnetup for $target_rid..."
    fi
    
    # Ensure output directory exists
    mkdir -p "$output_dir"
    
    # Build
    local publish_args=(
        publish "$dotnetup_project"
        -c Release
        -r "$target_rid"
        --self-contained
        -p:PublishSingleFile=true
        -p:IncludeNativeLibrariesForSelfExtract=true
        -o "$output_dir"
    )
    
    if [[ "$verbose" != "true" ]]; then
        publish_args+=(-v quiet --nologo)
    fi
    
    if ! dotnet "${publish_args[@]}"; then
        echo "Failed to build dotnetup for $target_rid" >&2
        return 1
    fi
    
    # Store the hash
    echo -n "$current_hash" > "$hash_file"
    
    if [[ "$verbose" == "true" ]]; then
        echo "dotnetup ($target_rid) built successfully."
    fi
    return 0
}

# Check if dotnet is available - if not, we can't rebuild
if ! command -v dotnet &> /dev/null; then
    if [[ "$verbose" == "true" ]]; then
        echo "dotnet SDK not available, using existing dotnetup executables."
    fi
    exit 0
fi

# Determine current platform RID
current_rid=$(get_current_rid)

# Determine which RIDs to build
rids_to_build=()
if [[ -n "$rid" ]]; then
    # Explicit RID specified - build only that one
    rids_to_build=("$rid")
elif [[ "$build_all" == "true" ]]; then
    # --all specified - build all RIDs sequentially (no background)
    rids_to_build=("${all_rids[@]}")
else
    # Default: build current RID first
    rids_to_build=("$current_rid")
fi

# Build for each target RID (current platform or explicit --rid)
all_succeeded=true
for target_rid in "${rids_to_build[@]}"; do
    if ! build_dotnetup_for_rid "$target_rid"; then
        all_succeeded=false
    fi
done

# If default mode (no --rid, no --all), spawn background processes for other RIDs
if [[ -z "$rid" && "$build_all" != "true" ]]; then
    script_path="${BASH_SOURCE[0]}"
    for target_rid in "${all_rids[@]}"; do
        if [[ "$target_rid" != "$current_rid" ]]; then
            args="--rid $target_rid"
            if [[ "$force" == "true" ]]; then args="$args --force"; fi
            if [[ "$verbose" == "true" ]]; then 
                echo "Starting background build for $target_rid..."
                args="$args --verbose"
            fi
            bash "$script_path" $args &
        fi
    done
fi

if [[ "$all_succeeded" != "true" ]]; then
    exit 1
fi
