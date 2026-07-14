// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

namespace Microsoft.TemplateSearch.TemplateDiscovery.Test;

/// <summary>
/// Runner-agnostic test output abstraction.  The shared
/// <c>Microsoft.TemplateEngine.CommandUtils</c> sources (compiled into this project via a
/// Compile link) reference the unqualified name <c>ITestOutputHelper</c>; a
/// <see langword="global using"/> in <c>GlobalUsings.cs</c> binds that name to this
/// interface, removing the xUnit dependency.
/// </summary>
internal interface ITestOutputHelper
{
    string Output { get; }

    void Write(string message);

    void Write(string format, params object[] args);

    void WriteLine(string message);

    void WriteLine(string format, params object[] args);
}
