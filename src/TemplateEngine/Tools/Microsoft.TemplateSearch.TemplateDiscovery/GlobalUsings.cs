// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

// The shared Microsoft.TemplateEngine.CommandUtils sources (compiled into this project
// via <Compile Include="..\Shared\**\*.cs" />) reference ITestOutputHelper by its short
// name.  Bind that name to the local runner-agnostic interface so this project compiles
// without any xUnit dependency.
global using ITestOutputHelper = Microsoft.TemplateSearch.TemplateDiscovery.Test.ITestOutputHelper;
