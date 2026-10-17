//! A small, allocation-free lexical scanner used for line classification,
//! approximate complexity estimation and import extraction.
//!
//! The scanner is intentionally *not* a parser. It understands comments,
//! string/character/template literals and (optionally) regex literals so that
//! those regions are never mistaken for code, and it classifies everything
//! else into words, numbers and punctuation. Every token is a slice into the
//! original buffer: no source bytes are copied.

const std = @import("std");
const Dialect = @import("language.zig").Dialect;

pub const TokenKind = enum {
    word,
    number,
    punct,
    string,
    comment,
    eof,
};

pub const Token = struct {
    kind: TokenKind,
    /// Slice into the source buffer (never copied).
    text: []const u8,
    /// 0-based physical line on which the token starts.
    line: u32,
    /// 0-based physical line on which the token ends.
    end_line: u32,
    /// Byte offset of the token start.
    start: u32,
};

pub const Scanner = struct {
    buf: []const u8,
    d: Dialect,
    pos: usize = 0,
    line: u32 = 0,
    /// Kind of the last token that was *not* a comment (used for regex
    /// disambiguation and statement boundary detection).
    prev_significant: TokenKind = .eof,

    pub fn init(buf: []const u8, d: Dialect) Scanner {
        return .{ .buf = buf, .d = d };
    }

    /// Returns the next token. Never fails: malformed input degrades into
    /// punctuation tokens rather than aborting a scan.
    pub fn next(self: *Scanner) Token {
        self.skipTrivia();
        const start = self.pos;
        const start_line = self.line;
        if (start >= self.buf.len) {
            return .{ .kind = .eof, .text = self.buf[self.buf.len..], .line = start_line, .end_line = start_line, .start = @intCast(start) };
        }

        const c = self.buf[start];

        if (self.matchComment(start)) |len| {
            self.pos += len;
            return self.finish(.comment, start, start_line);
        }
        if (self.matchStringOrChar(start)) |len| {
            self.pos += len;
            self.prev_significant = .string;
            return self.finish(.string, start, start_line);
        }
        if (self.d.regex_literals) {
            if (self.matchRegex(start)) |len| {
                self.pos += len;
                self.prev_significant = .string;
                return self.finish(.string, start, start_line);
            }
        }
        if (isWordStart(c)) {
            var i = start + 1;
            while (i < self.buf.len and isWordChar(self.buf[i])) : (i += 1) {}
            self.pos = i;
            self.prev_significant = .word;
            return self.finish(.word, start, start_line);
        }
        if (isDigit(c)) {
            var i = start + 1;
            while (i < self.buf.len and (isWordChar(self.buf[i]) or self.buf[i] == '.')) : (i += 1) {}
            self.pos = i;
            self.prev_significant = .number;
            return self.finish(.number, start, start_line);
        }
        if (comptime true) {
            const len = self.matchOperator(start);
            self.pos += len;
            self.prev_significant = .punct;
            return self.finish(.punct, start, start_line);
        }
    }

    fn finish(self: *Scanner, kind: TokenKind, start: usize, start_line: u32) Token {
        return .{
            .kind = kind,
            .text = self.buf[start..self.pos],
            .line = start_line,
            .end_line = self.line,
            .start = @intCast(start),
        };
    }

    fn skipTrivia(self: *Scanner) void {
        while (self.pos < self.buf.len) {
            switch (self.buf[self.pos]) {
                '\n' => {
                    self.pos += 1;
                    self.line += 1;
                },
                '\r' => {
                    self.pos += 1;
                    if (self.pos < self.buf.len and self.buf[self.pos] == '\n') self.pos += 1;
                    self.line += 1;
                },
                ' ', '\t', 0x0b, 0x0c => self.pos += 1,
                else => return,
            }
        }
    }

    /// Length of the comment starting at `i`, or `null`.
    fn matchComment(self: *Scanner, i: usize) ?usize {
        for (self.d.block_starts, self.d.block_ends) |bs, be| {
            if (std.mem.startsWith(u8, self.buf[i..], bs)) {
                var j = i + bs.len;
                while (j < self.buf.len) {
                    if (std.mem.startsWith(u8, self.buf[j..], be)) return j + be.len - i;
                    if (self.buf[j] == '\n') {
                        self.line += 1;
                    } else if (self.buf[j] == '\r') {
                        if (j + 1 < self.buf.len and self.buf[j + 1] == '\n') j += 1;
                        self.line += 1;
                    }
                    j += 1;
                }
                return self.buf.len - i;
            }
        }
        for (self.d.line_comments) |lc| {
            if (std.mem.startsWith(u8, self.buf[i..], lc)) {
                var j = i + lc.len;
                while (j < self.buf.len and self.buf[j] != '\n' and self.buf[j] != '\r') : (j += 1) {}
                return j - i;
            }
        }
        return null;
    }

    /// Longest-match string or character literal starting at `i`.
    fn matchStringOrChar(self: *Scanner, i: usize) ?usize {
        var best: ?usize = null;
        for (self.d.strings) |delim| {
            if (std.mem.startsWith(u8, self.buf[i..], delim)) {
                const end = self.scanDelimited(i + delim.len, delim);
                const total = end - i;
                if (best == null or total > best.?) best = total;
            }
        }
        if (best != null) return best;

        if (self.d.char_literals and self.buf[i] == '\'') {
            // Only treat `'` as a literal when a plausible closing quote is
            // close by. This keeps Rust lifetimes (`'a`) and C++ digit
            // separators from swallowing the rest of the file.
            var j = i + 1;
            var consumed: usize = 0;
            while (j < self.buf.len and consumed <= 4) : (j += 1) {
                const ch = self.buf[j];
                if (ch == '\n' or ch == '\r') return null;
                if (ch == self.d.escape) {
                    j += 1;
                    if (j >= self.buf.len) return null;
                    consumed += 2;
                    continue;
                }
                if (ch == '\'') return j + 1 - i;
                consumed += 1;
            }
        }
        return null;
    }

    fn scanDelimited(self: *Scanner, from: usize, delim: []const u8) usize {
        // Backticks (raw strings) and multi-character delimiters may span
        // lines; ordinary quotes may not.
        const multiline = delim.len > 1 or delim[0] == '`';
        var j = from;
        while (j < self.buf.len) {
            const ch = self.buf[j];
            if (ch == '\n') {
                // An unterminated single-line string stops at the break. The
                // line counter is left alone so that the whitespace skipper
                // accounts for the newline exactly once.
                if (!multiline) return j;
                self.line += 1;
                j += 1;
                continue;
            }
            if (ch == '\r') {
                if (!multiline) return j;
                if (j + 1 < self.buf.len and self.buf[j + 1] == '\n') j += 1;
                self.line += 1;
                j += 1;
                continue;
            }
            if (ch == self.d.escape) {
                j += 2;
                continue;
            }
            if (std.mem.startsWith(u8, self.buf[j..], delim)) return j + delim.len;
            j += 1;
        }
        return self.buf.len;
    }

    /// JavaScript regex literal heuristic: `/` only starts a regex when the
    /// previous significant token cannot end an expression.
    fn matchRegex(self: *Scanner, i: usize) ?usize {
        if (self.buf[i] != '/') return null;
        switch (self.prev_significant) {
            .word, .number, .string, .eof => return null,
            .punct, .comment => {},
        }
        // `)` `]` `}` end an expression, so a following `/` is division.
        var k = i;
        while (k > 0) : (k -= 1) {
            if (!isSpaceByte(self.buf[k - 1])) break;
        }
        if (k > 0) {
            if (self.buf[k - 1] == ')' or self.buf[k - 1] == ']' or self.buf[k - 1] == '}') return null;
        }
        var j = i + 1;
        var in_class = false;
        while (j < self.buf.len) {
            const ch = self.buf[j];
            if (ch == '\n' or ch == '\r') return null;
            if (ch == self.d.escape) {
                j += 2;
                continue;
            }
            if (ch == '[') in_class = true;
            if (ch == ']') in_class = false;
            if (ch == '/' and !in_class) {
                j += 1;
                while (j < self.buf.len and isWordChar(self.buf[j])) : (j += 1) {}
                return j - i;
            }
            j += 1;
        }
        return null;
    }

    /// Maximal-munch operator matching (multi-byte operators first).
    fn matchOperator(self: *Scanner, i: usize) usize {
        // Longest first: maximal munch.
        const ops = [_][]const u8{
            "...", "<<=", ">>=", "===", "!==", "**=", "??=", "&&=", "||=", ">>>",
            "=>",  "==",  "!=",  "<=",  ">=",  "&&",  "||",  "??",  "?.",  "::",
            "->",  "+=",  "-=",  "*=",  "/=",  "%=",  "&=",  "|=",  "^=",  "++",
            "--",  "**",  "//",  "<<",  ">>",  "/*",  "*/",  ":=",  "!",
        };
        for (ops) |op| {
            if (std.mem.startsWith(u8, self.buf[i..], op)) return op.len;
        }
        return 1;
    }
};

fn isSpaceByte(c: u8) bool {
    return c == ' ' or c == '\t' or c == 0x0b or c == 0x0c or c == '\r' or c == '\n';
}

pub fn isWordStart(c: u8) bool {
    return std.ascii.isAlphabetic(c) or c == '_' or c == '$' or c == '@' or c >= 0x80;
}

pub fn isWordChar(c: u8) bool {
    return std.ascii.isAlphanumeric(c) or c == '_' or c == '$' or c == '@' or c == '#' or c >= 0x80;
}

pub fn isDigit(c: u8) bool {
    return c >= '0' and c <= '9';
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

fn collect(allocator: std.mem.Allocator, src: []const u8, d: Dialect) ![]Token {
    var list = std.ArrayList(Token).init(allocator);
    var s = Scanner.init(src, d);
    while (true) {
        const t = s.next();
        try list.append(t);
        if (t.kind == .eof) break;
    }
    return list.toOwnedSlice();
}

fn kinds(allocator: std.mem.Allocator, src: []const u8, d: Dialect) ![]TokenKind {
    const toks = try collect(allocator, src, d);
    defer allocator.free(toks);
    const out = try allocator.alloc(TokenKind, toks.len - 1);
    for (toks[0 .. toks.len - 1], out) |t, *o| o.* = t.kind;
    return out;
}

const JS = @import("language.zig").JAVASCRIPT;
const PY = @import("language.zig").PYTHON;
const GO = blk: {
    const d = @import("language.zig").forExtension("go").?;
    break :blk d;
};

test "scanner classifies words, numbers and punctuation" {
    const src = "const answer = 42;";
    const k = try kinds(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(k);
    try std.testing.expectEqualSlices(TokenKind, &[_]TokenKind{ .word, .word, .punct, .number, .punct }, k);
}

test "line comments become comment tokens" {
    const src = "let a = 1; // note\nlet b = 2;";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    var found = false;
    for (toks) |t| {
        if (t.kind == .comment) {
            found = true;
            try std.testing.expectEqualStrings("// note", t.text);
        }
    }
    try std.testing.expect(found);
}

test "block comments span lines and advance the line counter" {
    const src = "a;\n/* one\n two\n three */\nb;";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    // tokens: a ; comment b ; eof
    try std.testing.expectEqual(@as(usize, 6), toks.len);
    try std.testing.expectEqual(TokenKind.comment, toks[2].kind);
    try std.testing.expectEqual(@as(u32, 1), toks[2].line);
    try std.testing.expectEqual(@as(u32, 3), toks[2].end_line);
    try std.testing.expectEqual(@as(u32, 4), toks[3].line);
}

test "strings hide code-like content" {
    const src = "const s = \"/* not a comment */ // nope\";";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    var strings: usize = 0;
    for (toks) |t| { if (t.kind == .string) strings += 1; }
    try std.testing.expectEqual(@as(usize, 1), strings);
}

test "escaped quotes do not terminate strings" {
    const src = "const s = \"a\\\"b\"; const t = 1;";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    var strings: usize = 0;
    var saw_t = false;
    for (toks) |t| {
        if (t.kind == .string) strings += 1;
        if (t.kind == .word and std.mem.eql(u8, t.text, "t")) saw_t = true;
    }
    try std.testing.expectEqual(@as(usize, 1), strings);
    try std.testing.expect(saw_t);
}

test "python triple quoted strings are one token" {
    const src = "x = '''\nline\n'''\ny = 1";
    const toks = try collect(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(toks);
    var strings: usize = 0;
    for (toks) |t| { if (t.kind == .string) strings += 1; }
    try std.testing.expectEqual(@as(usize, 1), strings);
}

test "python hash comments" {
    const src = "x = 1 # note # still\ny = 2";
    const toks = try collect(std.testing.allocator, src, PY);
    defer std.testing.allocator.free(toks);
    var comments: usize = 0;
    for (toks) |t| { if (t.kind == .comment) comments += 1; }
    try std.testing.expectEqual(@as(usize, 1), comments);
}

test "rust lifetimes are not char literals" {
    const RS = @import("language.zig").forExtension("rs").?;
    const src = "fn f<'a>(x: &'a str) -> &'a str { x }";
    const toks = try collect(std.testing.allocator, src, RS);
    defer std.testing.allocator.free(toks);
    var strings: usize = 0;
    for (toks) |t| { if (t.kind == .string) strings += 1; }
    try std.testing.expectEqual(@as(usize, 0), strings);
}

test "go raw strings are recognised" {
    const src = "s := `line\nline`";
    const toks = try collect(std.testing.allocator, src, GO);
    defer std.testing.allocator.free(toks);
    var strings: usize = 0;
    for (toks) |t| { if (t.kind == .string) strings += 1; }
    try std.testing.expectEqual(@as(usize, 1), strings);
}

test "multi-byte operators are matched greedily" {
    const src = "a === b && c ?? d ??= e";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    var text: [16][]const u8 = undefined;
    var n: usize = 0;
    for (toks) |t| {
        if (t.kind == .punct) {
            text[n] = t.text;
            n += 1;
        }
    }
    try std.testing.expectEqual(@as(usize, 4), n);
    try std.testing.expectEqualStrings("===", text[0]);
    try std.testing.expectEqualStrings("&&", text[1]);
}

test "empty input yields a single eof token" {
    const toks = try collect(std.testing.allocator, "", JS);
    defer std.testing.allocator.free(toks);
    try std.testing.expectEqual(@as(usize, 1), toks.len);
    try std.testing.expectEqual(TokenKind.eof, toks[0].kind);
}

test "CRLF line endings still advance lines" {
    const src = "a\r\nb\r\nc\r\n";
    const toks = try collect(std.testing.allocator, src, JS);
    defer std.testing.allocator.free(toks);
    try std.testing.expectEqual(@as(u32, 2), toks[2].line);
}

test "unicode identifiers are words" {
    const src = "const caf\u{00e9} = 1;";
    var s = Scanner.init(src, JS);
    _ = s.next(); // `const`
    const t = s.next();
    try std.testing.expectEqual(TokenKind.word, t.kind);
    try std.testing.expectEqualStrings("caf\u{00e9}", t.text);
}
