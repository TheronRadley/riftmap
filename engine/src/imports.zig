//! Import / reference extraction.
//!
//! Supported syntax today:
//!
//! * **JavaScript / TypeScript** - `import ... from "spec"`, side-effect
//!   `import "spec"`, `import type { T } from "spec"`, dynamic
//!   `import("spec")`, `require("spec")`, and `export ... from "spec"`.
//! * **Python** - `import a.b`, `import a.b as c`, `from a.b import c`,
//!   `from . import c`, `from ..pkg import c` (including parenthesised,
//!   multi-line forms), plus `__import__("a")` and
//!   `importlib.import_module("a")`.
//!
//! Anything that is not recognised is simply not reported: the engine never
//! invents a dependency. Unresolved specifiers are still emitted, marked
//! `confidence = "unresolved"`, so the UI can distinguish a real external
//! package from a reference the engine could not follow.

const std = @import("std");
const Dialect = @import("language.zig").Dialect;
const Scanner = @import("lexer.zig").Scanner;
const TokenKind = @import("lexer.zig").TokenKind;

pub const ImportKind = enum {
    /// `import x from "./y"`
    static,
    /// `import "./y"`
    side_effect,
    /// `import("./y")`
    dynamic,
    /// `require("./y")`
    require,
    /// `export { a } from "./y"`
    re_export,
    /// `import type { T } from "./y"`
    type_only,
    /// Python `import x`
    module,
    /// Python `from x import y`
    from_import,
};

pub const ImportRef = struct {
    /// The literal specifier text, e.g. `"./utils"` or `os.path`.
    raw: []const u8,
    kind: ImportKind,
    /// 0-based line of the specifier.
    line: u32,
};

/// Strip the surrounding quote characters from a string literal token and
/// return an owned copy. Every `raw` in an `ImportList` is heap owned so that
/// `deinit` can release it uniformly.
pub fn unquote(allocator: std.mem.Allocator, text: []const u8) ![]const u8 {
    if (text.len >= 2) {
        const first = text[0];
        const last = text[text.len - 1];
        if ((first == '"' or first == '\'' or first == '`') and first == last) {
            return allocator.dupe(u8, text[1 .. text.len - 1]);
        }
    }
    return allocator.dupe(u8, text);
}

/// A significant token buffered for look-ahead during extraction.
pub const Tok = struct { kind: TokenKind, text: []const u8, line: u32 };

pub const ImportList = struct {
    items: []ImportRef,
    allocator: std.mem.Allocator,

    pub fn deinit(self: *ImportList) void {
        for (self.items) |item| self.allocator.free(item.raw);
        self.allocator.free(self.items);
    }
};

/// Extract import references for a dialect that supports it.
pub fn extract(allocator: std.mem.Allocator, src: []const u8, d: Dialect) !ImportList {
    if (!d.imports) return ImportList{ .items = &.{}, .allocator = allocator };
    if (std.mem.eql(u8, d.id, "python")) return extractPython(allocator, src, d);
    return extractJs(allocator, src, d);
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

/// Tokens after which a newline does *not* end the import statement.
const JS_CONTINUATION = [_][]const u8{
    ",", "(", "{", "[", "=", ":", "?", "=>", "&&", "||", "??", "...", "*", "}",
};

fn isContinuation(text: []const u8) bool {
    for (JS_CONTINUATION) |c| {
        if (std.mem.eql(u8, c, text)) return true;
    }
    return false;
}

/// A newline ends the statement when the previous token cannot continue it.
fn isStatementEnd(prev: ?[]const u8, prev_kind: TokenKind) bool {
    const p = prev orelse return true;
    switch (prev_kind) {
        .punct => return !isContinuation(p),
        .word => return std.mem.eql(u8, p, "from") or std.mem.eql(u8, p, "as") or std.mem.eql(u8, p, "type") or std.mem.eql(u8, p, "import") or std.mem.eql(u8, p, "export") or std.mem.eql(u8, p, "*"),
        .string => return true,
        else => return true,
    }
}

fn extractJs(allocator: std.mem.Allocator, src: []const u8, d: Dialect) !ImportList {
    var out = std.ArrayList(ImportRef).init(allocator);

    // Buffer every significant token so the scanner can look ahead.
    var toks = std.ArrayList(Tok).init(allocator);
    defer toks.deinit();
    {
        var s = Scanner.init(src, d);
        while (true) {
            const t = s.next();
            if (t.kind == TokenKind.eof) break;
            try toks.append(.{ .kind = t.kind, .text = t.text, .line = t.line });
        }
    }

    var i: usize = 0;
    while (i < toks.items.len) : (i += 1) {
        const t = toks.items[i];
        if (t.kind != TokenKind.word) continue;

        if (std.mem.eql(u8, t.text, "import")) {
            // `import.meta` is not a dependency.
            if (i + 1 < toks.items.len and toks.items[i + 1].kind == TokenKind.punct and std.mem.eql(u8, toks.items[i + 1].text, ".")) {
                continue;
            }
            if (i + 1 < toks.items.len and toks.items[i + 1].kind == TokenKind.punct and std.mem.eql(u8, toks.items[i + 1].text, "(")) {
                if (findStringAfter(toks.items, i + 2)) |hit| {
                    try out.append(.{ .raw = try unquote(allocator, hit.text), .kind = .dynamic, .line = hit.line });
                }
                continue;
            }
            const scan = scanJsImport(toks.items, i + 1);
            if (scan.spec) |spec| {
                try out.append(.{ .raw = try unquote(allocator, spec.text), .kind = scan.kind, .line = spec.line });
            }
            continue;
        }

        if (std.mem.eql(u8, t.text, "export")) {
            const scan = scanJsExport(toks.items, i + 1);
            if (scan.spec) |spec| {
                try out.append(.{ .raw = try unquote(allocator, spec.text), .kind = .re_export, .line = spec.line });
            }
            continue;
        }

        if (std.mem.eql(u8, t.text, "require")) {
            if (i + 1 < toks.items.len and toks.items[i + 1].kind == TokenKind.punct and std.mem.eql(u8, toks.items[i + 1].text, "(")) {
                if (findStringAfter(toks.items, i + 2)) |hit| {
                    try out.append(.{ .raw = try unquote(allocator, hit.text), .kind = .require, .line = hit.line });
                }
            }
        }
    }

    return ImportList{ .items = try out.toOwnedSlice(), .allocator = allocator };
}

fn findStringAfter(items: []Tok, from: usize) ?Tok {
    var j = from;
    while (j < items.len and j < from + 8) : (j += 1) {
        if (items[j].kind == TokenKind.string) return items[j];
        if (items[j].kind == TokenKind.punct and std.mem.eql(u8, items[j].text, ")")) return null;
    }
    return null;
}

const ScanResult = struct { spec: ?Tok, kind: ImportKind };

fn scanJsImport(items: []Tok, from: usize) ScanResult {
    var saw_from = false;
    var saw_type = false;
    var first_string: ?Tok = null;
    var string_after_from: ?Tok = null;
    var j = from;
    var prev: ?[]const u8 = "import";
    var prev_kind: TokenKind = .word;
    var prev_line: u32 = if (from > 0) items[from - 1].line else 0;

    while (j < items.len) : (j += 1) {
        const t = items[j];
        if (t.kind == TokenKind.punct and std.mem.eql(u8, t.text, ";")) break;
        if (t.line != prev_line and isStatementEnd(prev, prev_kind)) break;
        if (t.kind == TokenKind.string) {
            if (string_after_from == null) {
                if (saw_from) {
                    string_after_from = t;
                    break;
                } else if (first_string == null) {
                    first_string = t;
                    break;
                }
            }
        }
        if (t.kind == TokenKind.word) {
            if (std.mem.eql(u8, t.text, "from")) saw_from = true;
            if (std.mem.eql(u8, t.text, "type")) saw_type = true;
        }
        prev = t.text;
        prev_kind = t.kind;
        prev_line = t.line;
    }

    if (string_after_from) |s| {
        return .{ .spec = s, .kind = if (saw_type) ImportKind.type_only else ImportKind.static };
    }
    if (first_string) |s| {
        return .{ .spec = s, .kind = .side_effect };
    }
    return .{ .spec = null, .kind = .static };
}

fn scanJsExport(items: []Tok, from: usize) ScanResult {
    var saw_from = false;
    var j = from;
    var prev: ?[]const u8 = "export";
    var prev_kind: TokenKind = .word;
    var prev_line: u32 = if (from > 0) items[from - 1].line else 0;

    while (j < items.len) : (j += 1) {
        const t = items[j];
        if (t.kind == TokenKind.punct and std.mem.eql(u8, t.text, ";")) break;
        if (t.line != prev_line and isStatementEnd(prev, prev_kind)) break;
        if (t.kind == TokenKind.string and saw_from) return .{ .spec = t, .kind = .re_export };
        if (t.kind == TokenKind.word and std.mem.eql(u8, t.text, "from")) saw_from = true;
        prev = t.text;
        prev_kind = t.kind;
        prev_line = t.line;
    }
    return .{ .spec = null, .kind = .re_export };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

fn extractPython(allocator: std.mem.Allocator, src: []const u8, d: Dialect) !ImportList {
    var out = std.ArrayList(ImportRef).init(allocator);
    var toks = std.ArrayList(Tok).init(allocator);
    defer toks.deinit();
    {
        var s = Scanner.init(src, d);
        while (true) {
            const t = s.next();
            if (t.kind == TokenKind.eof) break;
            try toks.append(.{ .kind = t.kind, .text = t.text, .line = t.line });
        }
    }
    const items = toks.items;

    var i: usize = 0;
    while (i < items.len) : (i += 1) {
        const t = items[i];
        if (t.kind != TokenKind.word) continue;

        if (std.mem.eql(u8, t.text, "__import__") or std.mem.eql(u8, t.text, "import_module")) {
            if (i + 1 < items.len and items[i + 1].kind == TokenKind.punct and std.mem.eql(u8, items[i + 1].text, "(")) {
                if (findStringAfter(items, i + 2)) |hit| {
                    try out.append(.{ .raw = try unquote(allocator, hit.text), .kind = .module, .line = hit.line });
                }
            }
            continue;
        }

        if (std.mem.eql(u8, t.text, "from") and isFirstOnLine(items, i)) {
            // `from <dotted module> import ...`
            var j = i + 1;
            var module: ?[]const u8 = null;
            var depth: i32 = 0;
            while (j < items.len) : (j += 1) {
                const u = items[j];
                if (u.kind == TokenKind.punct and (std.mem.eql(u8, u.text, "(") or std.mem.eql(u8, u.text, "[") or std.mem.eql(u8, u.text, "{"))) depth += 1;
                if (u.kind == TokenKind.punct and (std.mem.eql(u8, u.text, ")") or std.mem.eql(u8, u.text, "]") or std.mem.eql(u8, u.text, "}"))) depth -= 1;
                if (u.kind == TokenKind.punct and std.mem.eql(u8, u.text, ";") and depth <= 0) break;
                if (u.kind == TokenKind.word and std.mem.eql(u8, u.text, "import") and depth <= 0) {
                    module = joinDotted(allocator, items[i + 1 .. j]) catch null;
                    i = j; // the `import` keyword is consumed by this statement
                    break;
                }
            }
            if (module) |m| {
                try out.append(.{ .raw = m, .kind = .from_import, .line = t.line });
            }
            continue;
        }

        if (std.mem.eql(u8, t.text, "import") and (isFirstOnLine(items, i) or precededOnlyByFrom(items, i))) {
            var j: usize = i + 1;
            var depth: i32 = 0;
            var seg_start: usize = i + 1;
            var end: usize = i + 1;
            while (j < items.len) : (j += 1) {
                const u = items[j];
                if (u.kind == TokenKind.punct and std.mem.eql(u8, u.text, "(")) depth += 1;
                if (u.kind == TokenKind.punct and std.mem.eql(u8, u.text, ")")) {
                    depth -= 1;
                    if (depth <= 0) {
                        end = j;
                        break;
                    }
                }
                if (depth <= 0 and (u.line != t.line or (u.kind == TokenKind.punct and std.mem.eql(u8, u.text, ";")))) break;
                // `import numpy as np` - stop at the alias.
                if (depth <= 0 and u.kind == TokenKind.word and std.mem.eql(u8, u.text, "as")) {
                    end = j;
                    break;
                }
                // `import json, sys` - two separate modules.
                if (depth <= 0 and u.kind == TokenKind.punct and std.mem.eql(u8, u.text, ",")) {
                    if (j > seg_start) {
                        if (joinDotted(allocator, items[seg_start..j])) |m| {
                            try out.append(.{ .raw = m, .kind = .module, .line = t.line });
                        } else |_| {}
                    }
                    seg_start = j + 1;
                    end = j + 1;
                    continue;
                }
                end = j + 1;
            }
            if (end > seg_start) {
                if (joinDotted(allocator, items[seg_start..end])) |m| {
                    try out.append(.{ .raw = m, .kind = .module, .line = t.line });
                } else |_| {}
            }
        }
    }

    return ImportList{ .items = try out.toOwnedSlice(), .allocator = allocator };
}

fn isFirstOnLine(items: []Tok, i: usize) bool {
    if (i == 0) return true;
    return items[i - 1].line != items[i].line;
}

fn precededOnlyByFrom(items: []Tok, i: usize) bool {
    var j = i;
    while (j > 0 and items[j - 1].line == items[i].line) : (j -= 1) {}
    if (j >= i) return false;
    if (!std.mem.eql(u8, items[j].text, "from")) return false;
    var k = j + 1;
    while (k < i) : (k += 1) {
        if (items[k].kind == TokenKind.word) continue;
        if (items[k].kind == TokenKind.punct and (std.mem.eql(u8, items[k].text, ".") or std.mem.eql(u8, items[k].text, "*"))) continue;
        return false;
    }
    return true;
}

/// Rebuild a dotted module name from word/dot tokens, e.g. `a` `.` `b` -> "a.b".
fn joinDotted(allocator: std.mem.Allocator, toks: []Tok) ![]const u8 {
    var buf = std.ArrayList(u8).init(allocator);
    var saw_word = false;
    var last_was_dot = false;
    for (toks) |t| {
        if (t.kind == TokenKind.word) {
            try buf.appendSlice(t.text);
            saw_word = true;
            last_was_dot = false;
        } else if (t.kind == TokenKind.punct and std.mem.eql(u8, t.text, ".")) {
            // Leading dots are relative-import levels and are all preserved.
            if (!saw_word or !last_was_dot) try buf.append('.');
            last_was_dot = true;
        } else if (t.kind == TokenKind.punct and std.mem.eql(u8, t.text, ",")) {
            break;
        }
    }
    return buf.toOwnedSlice();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const JS = @import("language.zig").JAVASCRIPT;
const TS = @import("language.zig").TYPESCRIPT;
const PY = @import("language.zig").PYTHON;

/// Joins every extracted specifier with a newline, which makes assertions
/// readable and avoids relying on slice-pointer equality in the test runner.
fn specs(allocator: std.mem.Allocator, src: []const u8, d: Dialect) ![]const u8 {
    var list = try extract(allocator, src, d);
    defer list.deinit();
    var buf = std.ArrayList(u8).init(allocator);
    for (list.items, 0..) |item, i| {
        if (i > 0) try buf.append('\n');
        try buf.appendSlice(item.raw);
    }
    return buf.toOwnedSlice();
}

test "js: default, named, namespace and side-effect imports" {
    const src =
        \\import React from "react";
        \\import { a, b as c } from "./local";
        \\import * as ns from "../pkg/mod";
        \\import "./polyfill";
        \\export { x } from "./reexport";
        \\export * from "./star";
    ;
    const got = try specs(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("react\n./local\n../pkg/mod\n./polyfill\n./reexport\n./star", got);
}

test "js: multiline import statements" {
    const src =
        \\import {
        \\  alpha,
        \\  beta,
        \\} from "./multi";
    ;
    const got = try specs(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("./multi", got);
}

test "js: dynamic import and require" {
    const src = "const a = await import(\"./dyn\");\nconst b = require('./req');\n";
    const got = try specs(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("./dyn\n./req", got);
}

test "ts: type-only imports" {
    const src = "import type { Foo } from \"./types\";\nimport { type Bar } from './more';\n";
    var list = try extract(std.testing.allocator, src, TS);
    defer list.deinit();
    try std.testing.expectEqual(@as(usize, 2), list.items.len);
    try std.testing.expectEqual(ImportKind.type_only, list.items[0].kind);
    try std.testing.expectEqualStrings("./types", list.items[0].raw);
}

test "ts: import.meta is not a dependency" {
    const src = "const url = import.meta.url;\n";
    const got = try specs(std.testing.allocator, src, TS);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("", got);
}

test "js: keywords inside strings are not imports" {
    const src = "const code = \"import x from 'fake'\";\n";
    const got = try specs(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(got);
    // The scanner strips strings, so the source text inside the literal is
    // not mistaken for a real import statement.
    try std.testing.expectEqualStrings("", got);
}

test "js: statements after the import are not absorbed" {
    const src = "import a from \"./a\";\nconst x = 1;\nfunction f() {}\n";
    var list = try extract(std.testing.allocator, src, JS);
    defer list.deinit();
    try std.testing.expectEqual(@as(usize, 1), list.items.len);
    try std.testing.expectEqualStrings("./a", list.items[0].raw);
}

test "python: plain and dotted imports" {
    const src = "import os\nimport os.path\nimport numpy as np\nimport json, sys\n";
    const got = try specs(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("os\nos.path\nnumpy\njson\nsys", got);
}

test "python: from imports including relative levels" {
    const src = "from os import path\nfrom . import sibling\nfrom ..pkg.sub import thing\nfrom a.b.c import (\n    x,\n    y,\n)\n";
    const got = try specs(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("os\n.\n..pkg.sub\na.b.c", got);
}

test "python: yield-from and raise-from are not imports" {
    const src = "def f():\n    yield from g()\ntry:\n    pass\nexcept E as e:\n    raise X from e\n";
    const got = try specs(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("", got);
}

test "python: dynamic import helpers" {
    const src = "m = __import__(\"dyn\")\nn = importlib.import_module('imp')\n";
    const got = try specs(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings("dyn\nimp", got);
}

test "unsupported dialects report no imports" {
    const GO = @import("language.zig").forExtension("go").?;
    const src = "import \"fmt\"\n";
    const got = try specs(std.testing.allocator, src, GO);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqual(@as(usize, 0), got.len);
}
