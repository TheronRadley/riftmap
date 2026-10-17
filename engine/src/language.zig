//! Language and dialect definitions for the Riftmap analysis engine.
//!
//! Every source extension the engine understands maps to a `Dialect`, which
//! describes the lexical rules (comments, strings, escapes), whether the
//! engine claims support for complexity estimation and import extraction, and
//! which keywords/operators are counted as decision points.
//!
//! Riftmap is deliberately explicit about what it does *not* support: a
//! dialect carrying `complexity == false` or `imports == false` is reported to
//! the UI as "not analysed for this metric" rather than being silently
//! approximated.

const std = @import("std");

pub const Dialect = struct {
    /// Stable machine identifier, e.g. `"typescript"`.
    id: []const u8,
    /// Human readable name, e.g. `"TypeScript"`.
    name: []const u8,
    /// Line-comment prefixes.
    line_comments: []const []const u8 = &.{},
    /// Block-comment start markers, parallel to `block_ends`.
    block_starts: []const []const u8 = &.{},
    /// Block-comment end markers, parallel to `block_starts`.
    block_ends: []const []const u8 = &.{},
    /// String delimiters, longest first.
    strings: []const []const u8 = &.{},
    /// Support single-quoted character literals such as `'a'` or `'\n'`.
    char_literals: bool = false,
    /// Escape character used inside string and character literals.
    escape: u8 = '\\',
    /// Support `/pattern/flags` regex literals (JavaScript family).
    regex_literals: bool = false,
    /// Lexical complexity estimation is available for this dialect.
    complexity: bool = false,
    /// Import / reference extraction is available for this dialect.
    imports: bool = false,
    /// Keyword that introduces a function or method declaration.
    fn_keyword: ?[]const u8 = null,
    /// Also detect `name(...) { ... }` style declarations heuristically.
    fn_heuristic: bool = false,
    /// `=>` introduces a function (JavaScript arrow functions).
    arrow_fn: bool = false,
    /// Words that introduce an additional branch (decision point).
    decision_words: []const []const u8 = &.{},
    /// Words that introduce a loop.
    loop_words: []const []const u8 = &.{},
    /// Logical operators that introduce a decision point.
    logic_ops: []const []const u8 = &.{},
    /// The `?:` ternary operator is supported.
    ternary: bool = false,
    /// Nesting is measured with braces (`true`) or indentation (`false`).
    brace_nesting: bool = true,
    /// A triple-quoted string that opens a statement is documentation rather
    /// than code (Python docstrings).
    docstrings: bool = false,
};

// --- shared keyword tables -------------------------------------------------

const C_DECISION = &[_][]const u8{ "if", "case", "catch" };
const C_LOOP = &[_][]const u8{ "for", "while" };
const C_LOGIC = &[_][]const u8{ "&&", "||", "??" };

const JS_STRINGS = &[_][]const u8{ "\"", "'", "`" };
const C_BLOCK_START = &[_][]const u8{"/*"};
const C_BLOCK_END = &[_][]const u8{"*/"};
const C_LINE = &[_][]const u8{"//"};

pub const JAVASCRIPT = Dialect{
    .id = "javascript",
    .name = "JavaScript",
    .line_comments = C_LINE,
    .block_starts = C_BLOCK_START,
    .block_ends = C_BLOCK_END,
    .strings = JS_STRINGS,
    .char_literals = false,
    .regex_literals = true,
    .complexity = true,
    .imports = true,
    .fn_keyword = "function",
    .fn_heuristic = true,
    .arrow_fn = true,
    .decision_words = C_DECISION,
    .loop_words = C_LOOP,
    .logic_ops = C_LOGIC,
    .ternary = true,
};

pub const TYPESCRIPT = Dialect{
    .id = "typescript",
    .name = "TypeScript",
    .line_comments = C_LINE,
    .block_starts = C_BLOCK_START,
    .block_ends = C_BLOCK_END,
    .strings = JS_STRINGS,
    .char_literals = false,
    .regex_literals = true,
    .complexity = true,
    .imports = true,
    .fn_keyword = "function",
    .fn_heuristic = true,
    .arrow_fn = true,
    .decision_words = C_DECISION,
    .loop_words = C_LOOP,
    .logic_ops = C_LOGIC,
    .ternary = true,
};

pub const PYTHON = Dialect{
    .id = "python",
    .name = "Python",
    .line_comments = &[_][]const u8{"#"},
    .block_starts = &.{},
    .block_ends = &.{},
    .strings = &[_][]const u8{ "\"\"\"", "'''", "\"", "'" },
    .char_literals = false,
    .complexity = true,
    .imports = true,
    .fn_keyword = "def",
    .fn_heuristic = false,
    .decision_words = &[_][]const u8{ "if", "elif", "case", "except" },
    .loop_words = &[_][]const u8{ "for", "while" },
    .logic_ops = &[_][]const u8{ "and", "or" },
    .ternary = false,
    .brace_nesting = false,
    .docstrings = true,
};

fn cLike(
    id: []const u8,
    name: []const u8,
    comptime fn_keyword: ?[]const u8,
    comptime heuristic: bool,
    comptime complexity: bool,
    comptime extra_line: ?[]const u8,
) Dialect {
    return .{
        .id = id,
        .name = name,
        .line_comments = if (extra_line) |l| &[_][]const u8{ "//", l } else C_LINE,
        .block_starts = C_BLOCK_START,
        .block_ends = C_BLOCK_END,
        .strings = &[_][]const u8{"\""},
        .char_literals = true,
        .complexity = complexity,
        .imports = false,
        .fn_keyword = fn_keyword,
        .fn_heuristic = heuristic,
        .decision_words = C_DECISION,
        .loop_words = C_LOOP,
        .logic_ops = C_LOGIC,
        .ternary = true,
    };
}

// --- extension table -------------------------------------------------------

const ExtEntry = struct {
    ext: []const u8,
    dialect: Dialect,
};

const EXTENSIONS = [_]ExtEntry{
    .{ .ext = "js", .dialect = JAVASCRIPT },
    .{ .ext = "jsx", .dialect = JAVASCRIPT },
    .{ .ext = "mjs", .dialect = JAVASCRIPT },
    .{ .ext = "cjs", .dialect = JAVASCRIPT },
    .{ .ext = "ts", .dialect = TYPESCRIPT },
    .{ .ext = "tsx", .dialect = TYPESCRIPT },
    .{ .ext = "mts", .dialect = TYPESCRIPT },
    .{ .ext = "cts", .dialect = TYPESCRIPT },
    .{ .ext = "py", .dialect = PYTHON },
    .{ .ext = "pyi", .dialect = PYTHON },
    .{ .ext = "c", .dialect = cLike("c", "C", null, true, true, null) },
    .{ .ext = "h", .dialect = cLike("c", "C", null, true, true, null) },
    .{ .ext = "cc", .dialect = cLike("cpp", "C++", null, true, true, null) },
    .{ .ext = "cpp", .dialect = cLike("cpp", "C++", null, true, true, null) },
    .{ .ext = "cxx", .dialect = cLike("cpp", "C++", null, true, true, null) },
    .{ .ext = "hpp", .dialect = cLike("cpp", "C++", null, true, true, null) },
    .{ .ext = "hh", .dialect = cLike("cpp", "C++", null, true, true, null) },
    .{ .ext = "cs", .dialect = cLike("csharp", "C#", null, true, true, null) },
    .{ .ext = "java", .dialect = cLike("java", "Java", null, true, true, null) },
    .{ .ext = "php", .dialect = cLike("php", "PHP", null, true, true, "#") },
    .{ .ext = "go", .dialect = .{
        .id = "go",
        .name = "Go",
        .line_comments = C_LINE,
        .block_starts = C_BLOCK_START,
        .block_ends = C_BLOCK_END,
        .strings = &[_][]const u8{ "\"", "`" },
        .char_literals = true,
        .complexity = true,
        .fn_keyword = "func",
        .decision_words = C_DECISION,
        .loop_words = C_LOOP,
        .logic_ops = C_LOGIC,
        .ternary = false,
    } },
    .{ .ext = "rs", .dialect = .{
        .id = "rust",
        .name = "Rust",
        .line_comments = C_LINE,
        .block_starts = C_BLOCK_START,
        .block_ends = C_BLOCK_END,
        .strings = &[_][]const u8{"\""},
        .char_literals = true,
        .complexity = true,
        .fn_keyword = "fn",
        .decision_words = &[_][]const u8{ "if", "match", "catch" },
        .loop_words = &[_][]const u8{ "loop", "while", "for" },
        .logic_ops = &[_][]const u8{ "&&", "||" },
        .ternary = false,
    } },
    .{ .ext = "swift", .dialect = cLike("swift", "Swift", "func", false, true, null) },
    .{ .ext = "kt", .dialect = cLike("kotlin", "Kotlin", "fun", false, true, null) },
    .{ .ext = "kts", .dialect = cLike("kotlin", "Kotlin", "fun", false, true, null) },
    .{ .ext = "scala", .dialect = cLike("scala", "Scala", "def", false, true, null) },
    // Lexically tracked but without complexity/import estimates.
    .{ .ext = "json", .dialect = .{ .id = "json", .name = "JSON", .strings = &[_][]const u8{"\""} } },
    .{ .ext = "css", .dialect = .{ .id = "css", .name = "CSS", .line_comments = C_LINE, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "scss", .dialect = .{ .id = "scss", .name = "SCSS", .line_comments = C_LINE, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "sass", .dialect = .{ .id = "scss", .name = "SCSS", .line_comments = C_LINE, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "less", .dialect = .{ .id = "css", .name = "CSS", .line_comments = C_LINE, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "html", .dialect = .{ .id = "html", .name = "HTML", .block_starts = &[_][]const u8{"<!--"}, .block_ends = &[_][]const u8{"-->"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "htm", .dialect = .{ .id = "html", .name = "HTML", .block_starts = &[_][]const u8{"<!--"}, .block_ends = &[_][]const u8{"-->"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "vue", .dialect = .{ .id = "html", .name = "HTML", .block_starts = &[_][]const u8{"<!--"}, .block_ends = &[_][]const u8{"-->"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "xml", .dialect = .{ .id = "xml", .name = "XML", .block_starts = &[_][]const u8{"<!--"}, .block_ends = &[_][]const u8{"-->"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "svg", .dialect = .{ .id = "xml", .name = "XML", .block_starts = &[_][]const u8{"<!--"}, .block_ends = &[_][]const u8{"-->"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "md", .dialect = .{ .id = "markdown", .name = "Markdown" } },
    .{ .ext = "markdown", .dialect = .{ .id = "markdown", .name = "Markdown" } },
    .{ .ext = "txt", .dialect = .{ .id = "text", .name = "Text" } },
    .{ .ext = "yml", .dialect = .{ .id = "yaml", .name = "YAML", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "yaml", .dialect = .{ .id = "yaml", .name = "YAML", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "toml", .dialect = .{ .id = "toml", .name = "TOML", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "ini", .dialect = .{ .id = "toml", .name = "TOML", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "sh", .dialect = .{ .id = "shell", .name = "Shell", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "bash", .dialect = .{ .id = "shell", .name = "Shell", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "zsh", .dialect = .{ .id = "shell", .name = "Shell", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "rb", .dialect = .{ .id = "ruby", .name = "Ruby", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "sql", .dialect = .{ .id = "sql", .name = "SQL", .line_comments = &[_][]const u8{"--"}, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{"'"} } },
    .{ .ext = "lua", .dialect = .{ .id = "lua", .name = "Lua", .line_comments = &[_][]const u8{"--"}, .block_starts = &[_][]const u8{"--[["}, .block_ends = &[_][]const u8{"]]"}, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "zig", .dialect = .{ .id = "zig", .name = "Zig", .line_comments = &[_][]const u8{"//"}, .strings = &[_][]const u8{"\""} } },
    .{ .ext = "proto", .dialect = .{ .id = "protobuf", .name = "Protobuf", .line_comments = C_LINE, .block_starts = C_BLOCK_START, .block_ends = C_BLOCK_END, .strings = &[_][]const u8{ "\"", "'" } } },
    .{ .ext = "graphql", .dialect = .{ .id = "graphql", .name = "GraphQL", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{"\""} } },
    .{ .ext = "gql", .dialect = .{ .id = "graphql", .name = "GraphQL", .line_comments = &[_][]const u8{"#"}, .strings = &[_][]const u8{"\""} } },
};

/// Fallback dialect used when the extension is unknown. Such files are *not*
/// tracked as source files by the scanner.
pub const UNKNOWN = Dialect{ .id = "unknown", .name = "Unknown" };

pub fn forExtension(ext: []const u8) ?Dialect {
    for (EXTENSIONS) |entry| {
        if (std.mem.eql(u8, entry.ext, ext)) return entry.dialect;
    }
    return null;
}

/// All dialects that the engine tracks, de-duplicated by id.
pub fn knownDialects(allocator: std.mem.Allocator) ![]Dialect {
    var list = std.ArrayList(Dialect).init(allocator);
    var seen = std.StringHashMap(void).init(allocator);
    defer seen.deinit();
    for (EXTENSIONS) |entry| {
        const gop = try seen.getOrPut(entry.dialect.id);
        if (gop.found_existing) continue;
        try list.append(entry.dialect);
    }
    return list.toOwnedSlice();
}

/// Extensions accepted by the JS/TS module resolver, in priority order.
pub const JS_RESOLVE_EXTS = [_][]const u8{ ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json" };
/// Index file basenames accepted by the JS/TS module resolver.
pub const JS_INDEX_FILES = [_][]const u8{ "index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs", "index.json" };

pub fn isJavaScriptFamily(d: Dialect) bool {
    return std.mem.eql(u8, d.id, "javascript") or std.mem.eql(u8, d.id, "typescript");
}

pub fn isPythonFamily(d: Dialect) bool {
    return std.mem.eql(u8, d.id, "python");
}

test "extension lookup is deterministic" {
    try std.testing.expectEqualStrings("typescript", (forExtension("ts") orelse UNKNOWN).id);
    try std.testing.expectEqualStrings("typescript", (forExtension("tsx") orelse UNKNOWN).id);
    try std.testing.expectEqualStrings("python", (forExtension("py") orelse UNKNOWN).id);
    try std.testing.expectEqualStrings("javascript", (forExtension("mjs") orelse UNKNOWN).id);
    try std.testing.expect(forExtension("exe") == null);
    try std.testing.expect(forExtension("") == null);
}

test "complexity support is limited to the documented dialects" {
    try std.testing.expect((forExtension("ts") orelse UNKNOWN).complexity);
    try std.testing.expect((forExtension("py") orelse UNKNOWN).complexity);
    try std.testing.expect((forExtension("rs") orelse UNKNOWN).complexity);
    try std.testing.expect(!(forExtension("md") orelse UNKNOWN).complexity);
    try std.testing.expect(!(forExtension("json") orelse UNKNOWN).complexity);
}

test "import extraction is limited to the documented dialects" {
    try std.testing.expect((forExtension("js") orelse UNKNOWN).imports);
    try std.testing.expect((forExtension("py") orelse UNKNOWN).imports);
    try std.testing.expect(!(forExtension("go") orelse UNKNOWN).imports);
    try std.testing.expect(!(forExtension("rs") orelse UNKNOWN).imports);
}
