//! Deterministic JSON emission.
//!
//! The output document is produced from a fixed struct layout, so field order
//! is stable and byte-for-byte reproducible for identical input. Optional
//! metrics are emitted as JSON `null` rather than being omitted, which keeps
//! the shape predictable for consumers.

const std = @import("std");
const analyze = @import("analyze.zig");

pub const build = @import("build_options");

pub const EngineInfo = struct {
    name: []const u8 = "riftmap-engine",
    version: []const u8 = build.version,
    zig_version: []const u8,
    build_mode: []const u8 = build.optimize,
};

pub const ScanInfo = struct {
    root: []const u8,
    started_at_ms: i64,
    duration_ms: i64,
    options: OptionsEcho,
    limitations: Limitations,
};

pub const OptionsEcho = struct {
    max_file_bytes: u64,
    large_file_mode: []const u8,
    max_files: usize,
    max_depth: usize,
    include_hidden: bool,
    use_gitignore: bool,
    extract_imports: bool,
    compute_complexity: bool,
};

pub const Limitations = struct {
    /// Line / complexity metrics are lexical estimates, not compiler-grade AST analysis.
    metrics_are_estimates: bool = true,
    /// Only root-level `.gitignore` / `.riftmapignore` files are applied.
    nested_ignore_files_supported: bool = false,
    /// Import resolution covers JavaScript, TypeScript and Python.
    import_languages: []const []const u8 = &.{ "javascript", "typescript", "python" },
    /// Comments and strings are stripped; everything else is an approximation.
    unknown_language_complexity: []const u8 = "not analysed",
};

pub const FileOut = struct {
    path: []const u8,
    ext: []const u8,
    language: []const u8,
    language_name: []const u8,
    bytes: u64,
    lines: u32,
    code_lines: ?u32,
    blank_lines: ?u32,
    comment_lines: ?u32,
    cyclomatic: ?u32,
    branch_count: ?u32,
    loop_count: ?u32,
    logical_count: ?u32,
    max_nesting: ?u32,
    function_count: ?u32,
    token_count: ?u32,
    content_scanned: bool,
    complexity_available: bool,
    imports_available: bool,
    import_count: u32,
    resolved_import_count: u32,
};

pub const EdgeOut = struct {
    from: []const u8,
    to: ?[]const u8,
    raw: []const u8,
    kind: []const u8,
    confidence: []const u8,
    line: u32,
};

pub const LangOut = struct {
    id: []const u8,
    name: []const u8,
    file_count: usize,
    bytes: u64,
    code_lines: u64,
    total_lines: u64,
    complexity_supported: bool,
    imports_supported: bool,
};

pub const DirOut = struct {
    path: []const u8,
    file_count: usize,
    bytes: u64,
    code_lines: u64,
    total_lines: u64,
    direct: bool,
};

pub const WarningOut = struct {
    code: []const u8,
    message: []const u8,
    path: ?[]const u8,
};

pub const Document = struct {
    schemaVersion: u32,
    engine: EngineInfo,
    scan: ScanInfo,
    summary: analyze.Summary,
    languages: []LangOut,
    directories: []DirOut,
    files: []FileOut,
    edges: []EdgeOut,
    warnings: []WarningOut,
};

/// Convert an analysis result into a serialisable document.
pub fn buildDocument(allocator: std.mem.Allocator, res: *const analyze.Result, opts: analyze.Options, zig_version: []const u8) !Document {
    const files = try allocator.alloc(FileOut, res.files.len);
    for (res.files, files) |f, *o| {
        o.* = .{
            .path = f.path,
            .ext = f.ext,
            .language = f.language,
            .language_name = f.language_name,
            .bytes = f.bytes,
            .lines = f.lines,
            .code_lines = f.code_lines,
            .blank_lines = f.blank_lines,
            .comment_lines = f.comment_lines,
            .cyclomatic = f.cyclomatic,
            .branch_count = f.branch_count,
            .loop_count = f.loop_count,
            .logical_count = f.logical_count,
            .max_nesting = f.max_nesting,
            .function_count = f.function_count,
            .token_count = f.token_count,
            .content_scanned = f.content_scanned,
            .complexity_available = f.complexity_available,
            .imports_available = f.imports_available,
            .import_count = f.import_count,
            .resolved_import_count = f.resolved_import_count,
        };
    }

    const edges = try allocator.alloc(EdgeOut, res.edges.len);
    for (res.edges, edges) |e, *o| {
        o.* = .{
            .from = e.from,
            .to = e.to,
            .raw = e.raw,
            .kind = e.kind,
            .confidence = e.confidence,
            .line = e.line,
        };
    }

    const langs = try allocator.alloc(LangOut, res.languages.len);
    for (res.languages, langs) |l, *o| {
        o.* = .{
            .id = l.id,
            .name = l.name,
            .file_count = l.file_count,
            .bytes = l.bytes,
            .code_lines = l.code_lines,
            .total_lines = l.total_lines,
            .complexity_supported = l.complexity_supported,
            .imports_supported = l.imports_supported,
        };
    }

    const dirs = try allocator.alloc(DirOut, res.directories.len);
    for (res.directories, dirs) |d, *o| {
        o.* = .{
            .path = d.path,
            .file_count = d.file_count,
            .bytes = d.bytes,
            .code_lines = d.code_lines,
            .total_lines = d.total_lines,
            .direct = d.direct,
        };
    }

    const warns = try allocator.alloc(WarningOut, res.warnings.len);
    for (res.warnings, warns) |w, *o| {
        o.* = .{ .code = w.code, .message = w.message, .path = w.path };
    }

    const now = std.time.milliTimestamp();

    return .{
        .schemaVersion = analyze.SCHEMA_VERSION,
        .engine = .{ .zig_version = zig_version },
        .scan = .{
            .root = res.root,
            .started_at_ms = now - res.summary.elapsed_ms,
            .duration_ms = res.summary.elapsed_ms,
            .options = .{
                .max_file_bytes = opts.max_file_bytes,
                .large_file_mode = @tagName(opts.large_file_mode),
                .max_files = opts.max_files,
                .max_depth = opts.max_depth,
                .include_hidden = opts.include_hidden,
                .use_gitignore = opts.use_gitignore,
                .extract_imports = opts.extract_imports,
                .compute_complexity = opts.compute_complexity,
            },
            .limitations = .{},
        },
        .summary = res.summary,
        .languages = langs,
        .directories = dirs,
        .files = files,
        .edges = edges,
        .warnings = warns,
    };
}

pub fn freeDocument(allocator: std.mem.Allocator, doc: *Document) void {
    allocator.free(doc.files);
    allocator.free(doc.edges);
    allocator.free(doc.languages);
    allocator.free(doc.directories);
    allocator.free(doc.warnings);
}

/// Serialise `doc` to `writer`. Field order follows struct declaration order.
pub fn writeDocument(doc: *const Document, writer: anytype, pretty: bool) !void {
    const options: std.json.StringifyOptions = if (pretty)
        .{ .whitespace = .indent_2 }
    else
        .{ .whitespace = .minified };
    try std.json.stringify(doc.*, options, writer);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test "json output is deterministic and contains the schema version" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "a.ts", .data = "export const a = 1;\n" });
    try tmp.dir.writeFile(.{ .sub_path = "b.ts", .data = "import { a } from \"./a\";\nexport const b = a + 1;\n" });
    const root = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(root);

    const opts = analyze.Options{ .root = root };
    var res = try analyze.analyze(allocator, opts);
    defer res.deinit();
    var doc = try buildDocument(allocator, &res, opts, "0.13.0");
    defer freeDocument(allocator, &doc);

    // A second, independent analysis of the same tree must serialise
    // identically. Wall-clock fields are zeroed first so that only the
    // analysed content is compared.
    var res2 = try analyze.analyze(allocator, opts);
    defer res2.deinit();
    var doc2 = try buildDocument(allocator, &res2, opts, "0.13.0");
    defer freeDocument(allocator, &doc2);
    doc.scan.started_at_ms = 0;
    doc.scan.duration_ms = 0;
    doc.summary.elapsed_ms = 0;
    doc2.scan.started_at_ms = 0;
    doc2.scan.duration_ms = 0;
    doc2.summary.elapsed_ms = 0;

    var out1 = std.ArrayList(u8).init(allocator);
    defer out1.deinit();
    try writeDocument(&doc, out1.writer(), true);
    var out2 = std.ArrayList(u8).init(allocator);
    defer out2.deinit();
    try writeDocument(&doc2, out2.writer(), true);

    try std.testing.expectEqualSlices(u8, out1.items, out2.items);
    try std.testing.expect(std.mem.indexOf(u8, out1.items, "\"schemaVersion\": 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, out1.items, "\"b.ts\"") != null);
}

test "optional metrics are emitted as null, not omitted" {
    const allocator = std.testing.allocator;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "notes.md", .data = "# hello\n" });
    const root = try tmp.dir.realpathAlloc(allocator, ".");
    defer allocator.free(root);
    const opts = analyze.Options{ .root = root };
    var res = try analyze.analyze(allocator, opts);
    defer res.deinit();
    var doc = try buildDocument(allocator, &res, opts, "0.13.0");
    defer freeDocument(allocator, &doc);
    var out = std.ArrayList(u8).init(allocator);
    defer out.deinit();
    try writeDocument(&doc, out.writer(), true);
    // Markdown has no complexity support, so cyclomatic must be null.
    try std.testing.expect(std.mem.indexOf(u8, out.items, "\"cyclomatic\": null") != null);
}
