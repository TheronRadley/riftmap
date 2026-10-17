//! Line classification and approximate lexical complexity.
//!
//! ## Definitions
//!
//! * **Physical lines** - the number of line terminators in the file, plus one
//!   when the file does not end with a terminator. `\n`, `\r\n` and lone `\r`
//!   are all recognised.
//! * **Code lines** - physical lines that contain at least one token which is
//!   neither a comment nor whitespace.
//! * **Comment lines** - physical lines whose only tokens are comments.
//! * **Blank lines** - physical lines with no tokens at all.
//!
//! A line containing both code and a trailing comment is counted as a code
//! line, so `code + comment + blank == lines` always holds.
//!
//! **Estimated cyclomatic complexity** is `1 + decision_points`, where a
//! decision point is one of: a branch keyword (`if`, `elif`, `case`, `catch`,
//! `except`, `match`, `select`), a loop keyword (`for`, `while`, `loop`), a
//! logical operator (`&&`, `||`, `??`, `and`, `or`) or a `?:` ternary.
//!
//! This is a lexical approximation, not a control-flow graph. It cannot see
//! short-circuiting, preprocessor branches or polymorphism.

const std = @import("std");
const Dialect = @import("language.zig").Dialect;
const Scanner = @import("lexer.zig").Scanner;
const TokenKind = @import("lexer.zig").TokenKind;

pub const LineCounts = struct {
    lines: u32 = 0,
    code: u32 = 0,
    comment: u32 = 0,
    blank: u32 = 0,
};

/// Counts physical lines only, streaming the file in fixed-size chunks so that
/// arbitrarily large files can be measured without buffering them.
///
/// `\n`, `\r\n` and a lone `\r` each terminate one line.
pub fn countPhysicalLines(file: std.fs.File) !u32 {
    var reader = file.reader();
    var buf: [65536]u8 = undefined;
    var total: u32 = 0;
    var last: u8 = 0;
    while (true) {
        const n = try reader.read(&buf);
        if (n == 0) break;
        for (buf[0..n]) |c| {
            if (c == '\n' or c == '\r') total += 1;
        }
        last = buf[n - 1];
        if (n < buf.len) break;
    }
    // A trailing fragment without a terminator still counts as a line.
    if (last != 0 and last != '\n' and last != '\r') total += 1;
    return total;
}

/// Physical line count for an in-memory buffer.
pub fn countLinesMem(src: []const u8) u32 {
    var total: u32 = 0;
    var i: usize = 0;
    while (i < src.len) : (i += 1) {
        if (src[i] == '\n') {
            total += 1;
        } else if (src[i] == '\r') {
            total += 1;
            if (i + 1 < src.len and src[i + 1] == '\n') i += 1;
        }
    }
    if (src.len > 0) {
        const last = src[src.len - 1];
        if (last != '\n' and last != '\r') total += 1;
    }
    return total;
}

/// Reusable scratch space so that per-file analysis does not allocate.
pub const Analyzer = struct {
    line_flags: []u8 = &.{},
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) Analyzer {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Analyzer) void {
        if (self.line_flags.len > 0) self.allocator.free(self.line_flags);
        self.line_flags = &.{};
    }

    fn ensureLines(self: *Analyzer, n: usize) !void {
        if (self.line_flags.len >= n) return;
        const new = try self.allocator.alloc(u8, n);
        @memset(new, 0);
        if (self.line_flags.len > 0) self.allocator.free(self.line_flags);
        self.line_flags = new;
    }

    pub fn lineCounts(self: *Analyzer, src: []const u8, d: Dialect) !LineCounts {
        const physical = countLinesMem(src);

        try self.ensureLines(physical);
        @memset(self.line_flags[0..physical], 0);

        var scanner = Scanner.init(src, d);
        // Line of the most recent non-comment token, used to decide whether a
        // Python docstring opens a statement (documentation) or is used as an
        // expression (code).
        var last_code_line: ?u32 = null;
        while (true) {
            const t = scanner.next();
            if (t.kind == TokenKind.eof) break;
            var flag: u8 = if (t.kind == TokenKind.comment) 2 else 1;
            if (flag == 1 and d.docstrings and isDocstring(t.text) and
                (last_code_line == null or last_code_line.? != t.line))
            {
                flag = 2;
            } else if (flag == 1) {
                last_code_line = t.line;
            }
            var l = t.line;
            const end = @min(t.end_line, if (physical == 0) 0 else physical - 1);
            while (l <= end) : (l += 1) {
                // Code outranks comments on a mixed line, and a comment never
                // downgrades a line that already contains code.
                if (flag == 1) {
                    if (self.line_flags[l] != 1) self.line_flags[l] = 1;
                } else if (self.line_flags[l] == 0) {
                    self.line_flags[l] = 2;
                }
            }
        }

        var counts = LineCounts{ .lines = physical };
        for (self.line_flags[0..physical]) |f| {
            switch (f) {
                0 => counts.blank += 1,
                2 => counts.comment += 1,
                else => counts.code += 1,
            }
        }
        return counts;
    }
};

pub const Complexity = struct {
    /// 1 + number of lexical decision points.
    cyclomatic: u32 = 1,
    /// Branch keywords only (`if`, `case`, `catch`, ...).
    branch_count: u32 = 0,
    /// Loop keywords only.
    loop_count: u32 = 0,
    /// Logical operators and ternaries.
    logical_count: u32 = 0,
    /// Deepest nesting observed (braces, or indentation for Python).
    max_nesting: u32 = 0,
    /// Approximate function/method declaration count (null when unavailable).
    function_count: ?u32 = null,
    /// Non-comment, non-whitespace token count.
    token_count: u32 = 0,
};

/// True for Python triple-quoted string literals.
fn isDocstring(text: []const u8) bool {
    return std.mem.startsWith(u8, text, "\"\"\"") or std.mem.startsWith(u8, text, "'''");
}

fn isWordIn(haystack: []const []const u8, word: []const u8) bool {
    for (haystack) |w| {
        if (std.mem.eql(u8, w, word)) return true;
    }
    return false;
}

/// Control keywords that disqualify a `name(...)` sequence from being treated
/// as a function declaration.
const CONTROL_WORDS = [_][]const u8{
    "if", "else", "for", "while", "do", "switch", "case", "catch", "try",
    "finally", "return", "await", "yield", "new", "delete", "typeof",
    "instanceof", "in", "of", "with", "throw", "using", "match", "select",
    "when", "elif", "except", "and", "or", "not", "is", "as", "import",
    "from", "public", "private", "protected", "static", "const", "let",
    "var", "function", "def", "fn", "func", "fun", "class", "struct",
    "enum", "interface", "trait", "impl", "extends", "implements", "where",
    "synchronized", "abstract", "virtual", "override", "async", "unsafe",
    "pub", "goto", "sizeof", "typedef", "namespace", "template", "requires",
    "concept", "co_await", "co_yield", "co_return", "raise", "print", "echo",
};

fn isPunctIn(haystack: []const []const u8, text: []const u8) bool {
    for (haystack) |w| {
        if (std.mem.eql(u8, w, text)) return true;
    }
    return false;
}

pub fn complexity(src: []const u8, d: Dialect) Complexity {
    var result = Complexity{};
    // Only report a function count for dialects where detection is actually
    // attempted; for everything else it stays `null` ("not available").
    if (d.fn_keyword != null or d.fn_heuristic or d.arrow_fn) result.function_count = 0;
    var scanner = Scanner.init(src, d);

    // Token ring buffer holding the significant (non-comment) tokens, used for
    // the `name(...) {` declaration heuristic.
    var prev_words: [4][]const u8 = [_][]const u8{ "", "", "", "" };
    var prev_kinds: [4]TokenKind = [_]TokenKind{.eof} ** 4;
    var nprev: usize = 0;

    var depth: i32 = 0;
    var max_depth: u32 = 0;
    // Indentation-based nesting (Python).
    var indent_stack: [64]u32 = undefined;
    var indent_len: usize = 0;
    var line_started: bool = false;
    var current_line: ?u32 = null;
    var current_indent: u32 = 0;

    // State for the `name(...) { ... }` declaration heuristic.
    var paren_depth: i32 = 0;
    var in_candidate_paren: bool = false;
    var just_closed: bool = false;
    var suppress_next_candidate: bool = false;

    while (true) {
        const t = scanner.next();
        if (t.kind == TokenKind.eof) break;

        // --- indentation nesting -------------------------------------------
        if (!d.brace_nesting and (current_line == null or t.line != current_line.?)) {
            if (current_line != null and line_started) {
                applyIndent(&indent_stack, &indent_len, current_indent);
                const depth_now = if (indent_len > 0) indent_len - 1 else 0;
                if (depth_now > max_depth) max_depth = @intCast(depth_now);
            }
            current_line = t.line;
            current_indent = colOfLine(src, t.start);
            line_started = false;
        }

        if (t.kind == TokenKind.comment) continue;

        line_started = true;
        result.token_count += 1;
        const was_just_closed = just_closed;
        just_closed = false;

        switch (t.kind) {
            TokenKind.word => {
                if (isWordIn(d.decision_words, t.text)) {
                    result.cyclomatic += 1;
                    result.branch_count += 1;
                } else if (isWordIn(d.loop_words, t.text)) {
                    result.cyclomatic += 1;
                    result.loop_count += 1;
                } else if (d.logic_ops.len > 0 and isWordIn(d.logic_ops, t.text)) {
                    result.cyclomatic += 1;
                    result.logical_count += 1;
                }
                if (d.fn_keyword) |kw| {
                    if (std.mem.eql(u8, kw, t.text)) {
                        result.function_count = (result.function_count orelse 0) + 1;
                        // The following `name(...)` sequence belongs to the
                        // declaration we just counted.
                        suppress_next_candidate = true;
                    }
                }
            },
            TokenKind.punct => {
                if (d.logic_ops.len > 0 and isPunctIn(d.logic_ops, t.text)) {
                    result.cyclomatic += 1;
                    result.logical_count += 1;
                }
                if (d.ternary and std.mem.eql(u8, t.text, "?") and !std.mem.eql(u8, t.text, "?.")) {
                    // `?` used as a ternary or nullish marker. `?.` is
                    // optional chaining and is not a branch.
                    result.cyclomatic += 1;
                    result.logical_count += 1;
                }
                if (d.arrow_fn and std.mem.eql(u8, t.text, "=>")) {
                    result.function_count = (result.function_count orelse 0) + 1;
                }
                if (d.brace_nesting) {
                    if (std.mem.eql(u8, t.text, "{")) {
                        depth += 1;
                        if (depth > max_depth) max_depth = @intCast(depth);
                    } else if (std.mem.eql(u8, t.text, "}")) {
                        depth -= 1;
                        if (depth < 0) depth = 0;
                    }
                }
                // --- `name(...)` declaration heuristic ---------------------
                if (d.fn_heuristic) {
                    if (in_candidate_paren) {
                        if (std.mem.eql(u8, t.text, "(")) {
                            paren_depth += 1;
                        } else if (std.mem.eql(u8, t.text, ")")) {
                            paren_depth -= 1;
                            if (paren_depth <= 0) {
                                in_candidate_paren = false;
                                just_closed = true;
                            }
                        } else if (std.mem.eql(u8, t.text, "=>")) {
                            // An arrow inside the argument list means this is
                            // a call taking a callback; the arrow itself is
                            // counted separately.
                            in_candidate_paren = false;
                            paren_depth = 0;
                        }
                    } else if (std.mem.eql(u8, t.text, "(")) {
                        if (nprev > 0 and prev_kinds[(nprev - 1) % 4] == TokenKind.word) {
                            const name = prev_words[(nprev - 1) % 4];
                            const suppressed = suppress_next_candidate;
                            suppress_next_candidate = false;
                            if (!suppressed and !isWordIn(&CONTROL_WORDS, name)) {
                                in_candidate_paren = true;
                                paren_depth = 1;
                            }
                        }
                    } else if (was_just_closed and (std.mem.eql(u8, t.text, "{") or std.mem.eql(u8, t.text, "=>"))) {
                        result.function_count = (result.function_count orelse 0) + 1;
                    }
                }
            },
            else => {},
        }

        prev_words[nprev % 4] = t.text;
        prev_kinds[nprev % 4] = t.kind;
        nprev += 1;
    }

    if (!d.brace_nesting) {
        if (line_started) {
            applyIndent(&indent_stack, &indent_len, current_indent);
            const depth_now = if (indent_len > 0) indent_len - 1 else 0;
            if (depth_now > max_depth) max_depth = @intCast(depth_now);
        }
    }

    result.max_nesting = max_depth;
    return result;
}

fn applyIndent(stack: *[64]u32, len: *usize, indent: u32) void {
    while (len.* > 0 and stack[len.* - 1] >= indent) {
        len.* -= 1;
    }
    if (len.* < 64) {
        stack[len.*] = indent;
        len.* += 1;
    }
}

/// Column (in spaces, tab = 8) of byte offset `start` on its own line.
fn colOfLine(src: []const u8, start: u32) u32 {
    var i = start;
    while (i > 0) {
        i -= 1;
        if (src[i] == '\n' or src[i] == '\r') {
            i += 1;
            break;
        }
    }
    var col: u32 = 0;
    while (i < start) : (i += 1) {
        col += if (src[i] == '\t') 8 else 1;
    }
    return col;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

const JS = @import("language.zig").JAVASCRIPT;
const TS = @import("language.zig").TYPESCRIPT;
const PY = @import("language.zig").PYTHON;

fn countLinesFor(allocator: std.mem.Allocator, src: []const u8, d: Dialect) !LineCounts {
    var a = Analyzer.init(allocator);
    defer a.deinit();
    return a.lineCounts(src, d);
}

test "physical line counting: LF, CRLF, CR and no trailing newline" {
    var a = Analyzer.init(std.testing.allocator);
    defer a.deinit();
    try std.testing.expectEqual(@as(u32, 0), (try a.lineCounts("", JS)).lines);
    try std.testing.expectEqual(@as(u32, 1), (try a.lineCounts("a", JS)).lines);
    try std.testing.expectEqual(@as(u32, 3), (try a.lineCounts("a\nb\nc", JS)).lines);
    try std.testing.expectEqual(@as(u32, 3), (try a.lineCounts("a\nb\nc\n", JS)).lines);
    try std.testing.expectEqual(@as(u32, 3), (try a.lineCounts("a\r\nb\r\nc\r\n", JS)).lines);
    try std.testing.expectEqual(@as(u32, 3), (try a.lineCounts("a\rb\rc", JS)).lines);
}

test "code, comment and blank lines sum to physical lines" {
    const src = "// header\nlet a = 1;\n\n/* block\n   comment */\nlet b = 2; // trailing\n\n";
    const c = try countLinesFor(std.testing.allocator, src, JS);
    try std.testing.expectEqual(@as(u32, 7), c.lines);
    try std.testing.expectEqual(@as(u32, 2), c.code);
    try std.testing.expectEqual(@as(u32, 3), c.comment);
    try std.testing.expectEqual(@as(u32, 2), c.blank);
    try std.testing.expectEqual(c.lines, c.code + c.comment + c.blank);
}

test "trailing comments do not make a line a comment line" {
    const c = try countLinesFor(std.testing.allocator, "let a = 1; // x\n", JS);
    try std.testing.expectEqual(@as(u32, 1), c.code);
    try std.testing.expectEqual(@as(u32, 0), c.comment);
}

test "python module docstrings count as documentation, not code" {
    const src = "\"\"\"Module docstring.\nSecond line.\n\"\"\"\ndef f():\n    return 1\n";
    const c = try countLinesFor(std.testing.allocator, src, PY);
    try std.testing.expectEqual(@as(u32, 5), c.lines);
    try std.testing.expectEqual(@as(u32, 2), c.code);
    try std.testing.expectEqual(@as(u32, 3), c.comment);
    try std.testing.expectEqual(@as(u32, 0), c.blank);
}

test "python docstrings used as expressions count as code" {
    const src = "x = \"\"\"value\"\"\"\nprint(x)\n";
    const c = try countLinesFor(std.testing.allocator, src, PY);
    try std.testing.expectEqual(@as(u32, 2), c.code);
    try std.testing.expectEqual(@as(u32, 0), c.comment);
}

test "empty file yields zero lines" {
    const c = try countLinesFor(std.testing.allocator, "", JS);
    try std.testing.expectEqual(@as(u32, 0), c.lines);
    try std.testing.expectEqual(@as(u32, 0), c.code);
}

test "cyclomatic complexity of a straight-line function is 1" {
    const r = complexity("function f() { return 1; }", JS);
    try std.testing.expectEqual(@as(u32, 1), r.cyclomatic);
}

test "cyclomatic complexity counts branches and loops" {
    const src =
        \\function f(a, b) {
        \\  if (a) { return 1; }
        \\  for (let i = 0; i < b; i++) { a += i; }
        \\  while (a) { a -= 1; }
        \\  return a && b || a;
        \\}
    ;
    const r = complexity(src, JS);
    // if + for + while + && + ||
    try std.testing.expectEqual(@as(u32, 6), r.cyclomatic);
    try std.testing.expectEqual(@as(u32, 3), r.branch_count + r.loop_count);
    try std.testing.expectEqual(@as(u32, 2), r.logical_count);
}

test "complexity ignores keywords inside strings and comments" {
    const src = "const s = \"if for while && ||\"; // if for while";
    const r = complexity(src, JS);
    try std.testing.expectEqual(@as(u32, 1), r.cyclomatic);
}

test "python uses and/or/elif as decision points" {
    const src =
        \\def f(a, b):
        \\    if a:
        \\        return 1
        \\    elif b:
        \\        return 2
        \\    return a and b
    ;
    const r = complexity(src, PY);
    // if + elif + and
    try std.testing.expectEqual(@as(u32, 4), r.cyclomatic);
    try std.testing.expectEqual(@as(u32, 1), r.function_count.?);
}

test "max nesting is tracked with braces" {
    const src = "function f(){ if (a) { while (b) { c(); } } }";
    const r = complexity(src, JS);
    try std.testing.expectEqual(@as(u32, 3), r.max_nesting);
}

test "max nesting is tracked with indentation in python" {
    const src =
        \\def f():
        \\    if True:
        \\        for i in range(3):
        \\            pass
    ;
    const r = complexity(src, PY);
    try std.testing.expectEqual(@as(u32, 3), r.max_nesting);
}

test "function detection: declarations, arrows and methods" {
    const src =
        \\function a() {}
        \\const b = () => {};
        \\class C { m() {} }
        \\const o = { n() {} };
    ;
    const r = complexity(src, JS);
    try std.testing.expectEqual(@as(u32, 4), r.function_count.?);
}

test "function detection: calls are not declarations" {
    const src = "console.log('x');\nfoo(bar);\nif (x) { doThing(); }\n";
    const r = complexity(src, JS);
    try std.testing.expectEqual(@as(u32, 0), r.function_count.?);
}

test "function detection: go uses the func keyword" {
    const GO = @import("language.zig").forExtension("go").?;
    const src = "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n\nfunc other() int { return 1 }\n";
    const r = complexity(src, GO);
    try std.testing.expectEqual(@as(u32, 2), r.function_count.?);
}

test "function detection: rust uses the fn keyword" {
    const RS = @import("language.zig").forExtension("rs").?;
    const src = "fn main() {}\nfn other(x: u8) -> u8 { x }\n";
    const r = complexity(src, RS);
    try std.testing.expectEqual(@as(u32, 2), r.function_count.?);
}

test "complexity is 1 for an empty file" {
    const r = complexity("", JS);
    try std.testing.expectEqual(@as(u32, 1), r.cyclomatic);
    try std.testing.expectEqual(@as(u32, 0), r.token_count);
}

test "typescript nested generics do not break nesting depth" {
    const src = "function f<T>(x: T): T { if (x) { return x; } return x; }";
    const r = complexity(src, TS);
    try std.testing.expectEqual(@as(u32, 2), r.max_nesting);
}
