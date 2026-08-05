# Getting Started with dotnetup

`dotnetup` installs and manages user-level .NET SDK installations.

## Install an SDK

Use `dotnetup sdk install` with a channel or exact SDK version:

```bash
dotnetup sdk install latest
dotnetup sdk install lts
dotnetup sdk install daily
dotnetup sdk install 10.0
dotnetup sdk install 10.0.1xx
dotnetup sdk install 10.0-daily
dotnetup sdk install 10.0.100
```

Channels determine which SDK version is installed and how that installation is updated later.

| Channel | What it installs |
| --- | --- |
| `latest` | The newest stable .NET SDK |
| `lts` | The current Long Term Support SDK |
| `preview` | The latest preview or release candidate SDK |
| `daily` | The latest daily SDK build |
| `10.0` | The latest SDK for .NET 10.0 |
| `10.0.1xx` | The latest SDK in the 10.0.1xx feature band |
| `10.0-daily` | The latest daily SDK build for .NET 10.0 |
| `10.0.100` | Exactly SDK 10.0.100 |

Version-qualified daily channels use the `-daily` suffix. For example, `10.0-daily` is valid channel syntax for installing the latest daily SDK build in the .NET 10.0 channel.
