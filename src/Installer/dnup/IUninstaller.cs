// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Microsoft.DotNet.Tools.Bootstrapper
{
    internal interface IUninstaller
    {
        /// <summary>
        /// Prepares for uninstallation by validating that the target exists and can be uninstalled.
        /// </summary>
        void Prepare();

        /// <summary>
        /// Commits the uninstallation by removing files and updating the manifest.
        /// </summary>
        void Commit();
    }
}
