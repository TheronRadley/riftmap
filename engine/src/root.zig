//! Library root for the Riftmap analysis engine.
//!
//! `root.zig` is what `zig build test` exercises: importing it pulls in every
//! module so that all embedded `test` blocks run. The `main.zig` executable is
//! a thin CLI wrapper around the same modules.

pub const language = @import("language.zig");
pub const lexer = @import("lexer.zig");
pub const metrics = @import("metrics.zig");
pub const imports = @import("imports.zig");
pub const ignore = @import("ignore.zig");
pub const resolve = @import("resolve.zig");
pub const analyze = @import("analyze.zig");
pub const json_output = @import("json_output.zig");

pub const SCHEMA_VERSION = analyze.SCHEMA_VERSION;

comptime {
    _ = language;
    _ = lexer;
    _ = metrics;
    _ = imports;
    _ = ignore;
    _ = resolve;
    _ = analyze;
    _ = json_output;
}

test {
    // Pull in the tests declared in modules that are only reachable through
    // the executable entry point.
    _ = @import("main.zig");
}
