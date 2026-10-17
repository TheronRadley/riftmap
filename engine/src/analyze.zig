//! Repository traversal, per-file analysis and aggregation.
//!
//! The scanner walks the repository depth-first, keeping exactly one directory
//! handle open at a time so that deep or wide trees cannot exhaust file
//! descriptors. Files are read one at a time and released immediately: the
//! only data retained for the whole run is file *metadata* (paths, sizes,
//! counts, complexity figures and import references), never source bodies.

const std = @import("std");
const lang = @import("language.zig");
const ignore_mod = @import("ignore.zig");
const metrics = @import("metrics.zig");
const imports_mod = @import("imports.zig");
const resolve = @import("resolve.zig");

pub const SCHEMA_VERSION: u32 = 2;

pub const LargeFileMode = enum { skip, count_lines, full };

pub const Progress = struct {
    out: std.fs.File,
    start_ms: i64 = 0,
    last_emit_ms: i64 = 0,

    pub fn init(out: std.fs.File) Progress {
        return .{ .out = out, .start_ms = std.time.milliTimestamp(), .last_emit_ms = 0 };
    }

    /// Emits a single JSON line on stderr. Progress reporting must never be
    /// able to fail a scan, so all errors are swallowed here.
    pub fn emit(self: *Progress, stage: []const u8, files: u64, bytes: u64, dirs: u64, force: bool) void {
        const elapsed = std.time.milliTimestamp() - self.start_ms;
        if (!force and elapsed - self.last_emit_ms < 100) return;
        self.last_emit_ms = elapsed;
        var buf: [512]u8 = undefined;
        const line = std.fmt.bufPrint(&buf, "{{\"type\":\"progress\",\"stage\":\"{s}\",\"files\":{d},\"directories\":{d},\"bytes\":{d},\"elapsedMs\":{d}}}\n", .{ stage, files, dirs, bytes, elapsed }) catch return;
        self.out.writeAll(line) catch {};
    }
};

pub const Options = struct {
    root: []const u8,
    max_file_bytes: u64 = 8 * 1024 * 1024,
    large_file_mode: LargeFileMode = .count_lines,
    max_files: usize = 200_000,
    max_depth: usize = 64,
    max_total_bytes: u64 = 4 * 1024 * 1024 * 1024,
    include_hidden: bool = false,
    use_gitignore: bool = true,
    extra_ignore: []const []const u8 = &.{},
    extract_imports: bool = true,
    compute_complexity: bool = true,
    progress: ?*Progress = null,
};

pub const FileRecord = struct {
    path: []const u8,
    ext: []const u8,
    language: []const u8,
    language_name: []const u8,
    bytes: u64,
    lines: u32,
    code_lines: ?u32 = null,
    blank_lines: ?u32 = null,
    comment_lines: ?u32 = null,
    cyclomatic: ?u32 = null,
    branch_count: ?u32 = null,
    loop_count: ?u32 = null,
    logical_count: ?u32 = null,
    max_nesting: ?u32 = null,
    function_count: ?u32 = null,
    token_count: ?u32 = null,
    content_scanned: bool = false,
    complexity_available: bool = false,
    imports_available: bool = false,
    import_count: u32 = 0,
    resolved_import_count: u32 = 0,
};

pub const Edge = struct {
    from: []const u8,
    to: ?[]const u8 = null,
    raw: []const u8,
    kind: []const u8,
    confidence: []const u8,
    line: u32,
};

pub const LanguageStat = struct {
    id: []const u8,
    name: []const u8,
    file_count: usize = 0,
    bytes: u64 = 0,
    code_lines: u64 = 0,
    total_lines: u64 = 0,
    complexity_supported: bool = false,
    imports_supported: bool = false,
};

pub const DirStat = struct {
    path: []const u8,
    file_count: usize = 0,
    bytes: u64 = 0,
    code_lines: u64 = 0,
    total_lines: u64 = 0,
    /// Direct children only; the UI rolls nested directories up.
    direct: bool = true,
};

pub const Warning = struct {
    code: []const u8,
    message: []const u8,
    path: ?[]const u8 = null,
};

pub const Summary = struct {
    file_count: usize = 0,
    directory_count: usize = 0,
    total_bytes: u64 = 0,
    total_lines: u64 = 0,
    code_lines: u64 = 0,
    blank_lines: u64 = 0,
    comment_lines: u64 = 0,
    language_count: usize = 0,
    edge_count: usize = 0,
    resolved_edge_count: usize = 0,
    external_edge_count: usize = 0,
    unresolved_edge_count: usize = 0,
    files_with_complexity: usize = 0,
    files_with_imports: usize = 0,
    files_skipped_large: usize = 0,
    files_skipped_ignored: usize = 0,
    files_skipped_unreadable: usize = 0,
    files_skipped_unsupported: usize = 0,
    files_skipped_invalid_name: usize = 0,
    directories_skipped: usize = 0,
    symlinks_skipped: usize = 0,
    truncated: bool = false,
    elapsed_ms: i64 = 0,
};

pub const Result = struct {
    allocator: std.mem.Allocator,
    files: []FileRecord = &.{},
    edges: []Edge = &.{},
    languages: []LanguageStat = &.{},
    directories: []DirStat = &.{},
    warnings: []Warning = &.{},
    summary: Summary = .{},
    root: []const u8 = "",

    pub fn deinit(self: *Result) void {
        for (self.files) |f| {
            self.allocator.free(f.path);
            self.allocator.free(f.ext);
            self.allocator.free(f.language);
            self.allocator.free(f.language_name);
        }
        self.allocator.free(self.files);
        for (self.edges) |e| {
            self.allocator.free(e.from);
            self.allocator.free(e.raw);
            if (e.to) |t| self.allocator.free(t);
            self.allocator.free(e.kind);
            self.allocator.free(e.confidence);
        }
        self.allocator.free(self.edges);
        for (self.languages) |l| {
            self.allocator.free(l.id);
            self.allocator.free(l.name);
        }
        self.allocator.free(self.languages);
        for (self.directories) |d| self.allocator.free(d.path);
        self.allocator.free(self.directories);
        for (self.warnings) |w| {
            self.allocator.free(w.code);
            self.allocator.free(w.message);
            if (w.path) |p| self.allocator.free(p);
        }
        self.allocator.free(self.warnings);
        self.allocator.free(self.root);
    }
};

pub const AnalyzeError = error{
    OutOfMemory,
    RootNotFound,
    RootNotDirectory,
    RootAccessDenied,
};

// ---------------------------------------------------------------------------

pub fn analyze(allocator: std.mem.Allocator, opts: Options) AnalyzeError!Result {
    var result = Result{ .allocator = allocator };
    result.root = allocator.dupe(u8, opts.root) catch return error.OutOfMemory;
    errdefer result.deinit();

    const start_ms = std.time.milliTimestamp();

    var root_dir = std.fs.cwd().openDir(opts.root, .{ .iterate = true }) catch |err| switch (err) {
        error.AccessDenied => return error.RootAccessDenied,
        error.NotDir => return error.RootNotDirectory,
        else => return error.RootNotFound,
    };
    defer root_dir.close();

    var files = std.ArrayList(FileRecord).init(allocator);
    defer files.deinit();
    var file_imports = std.ArrayList([]imports_mod.ImportRef).init(allocator);
    defer {
        for (file_imports.items) |refs| {
            for (refs) |r| allocator.free(r.raw);
            allocator.free(refs);
        }
        file_imports.deinit();
    }
    var edges = std.ArrayList(Edge).init(allocator);
    defer edges.deinit();
    var warnings = std.ArrayList(Warning).init(allocator);
    defer warnings.deinit();
    var dir_stats = std.StringHashMap(DirStat).init(allocator);
    defer dir_stats.deinit();
    var lang_stats = std.StringHashMap(LanguageStat).init(allocator);
    defer lang_stats.deinit();
    var fileset = resolve.FileSet.init(allocator);
    defer fileset.deinit();
    var stack = std.ArrayList([]const u8).init(allocator);
    defer {
        for (stack.items) |item| allocator.free(item);
        stack.deinit();
    }

    var rules = ignore_mod.IgnoreRules.init(allocator) catch return error.OutOfMemory;
    defer rules.deinit();
    for (opts.extra_ignore) |p| rules.addPattern(p) catch return error.OutOfMemory;

    var analyzer = metrics.Analyzer.init(allocator);
    defer analyzer.deinit();
    var path_buf = resolve.PathBuf.init(allocator) catch return error.OutOfMemory;
    defer path_buf.deinit(allocator);

    if (opts.use_gitignore) rules.loadRepoIgnoreFiles(root_dir) catch {};

    stack.append(allocator.dupe(u8, "") catch return error.OutOfMemory) catch return error.OutOfMemory;

    var total_bytes: u64 = 0;
    var truncated = false;
    var name_storage: [1024]u8 = undefined;

    while (stack.popOrNull()) |rel| {
        defer allocator.free(rel);
        const depth = countDepth(rel);

        ensureDir(allocator, &dir_stats, rel) catch return error.OutOfMemory;

        var dir = root_dir.openDir(if (rel.len == 0) "." else rel, .{ .iterate = true, .no_follow = true }) catch |err| {
            addWarning(allocator, &warnings, switch (err) {
                error.AccessDenied => "dir-access-denied",
                error.SymLinkLoop => "symlink-dir",
                else => "dir-open-failed",
            }, "could not open directory", rel) catch {};
            result.summary.directories_skipped += 1;
            continue;
        };
        defer dir.close();

        var iter = dir.iterate();
        while (true) {
            const entry = iter.next() catch {
                addWarning(allocator, &warnings, "dir-read-failed", "could not read directory entries", rel) catch {};
                break;
            } orelse break;

            const name_owned = entry.name.len > name_storage.len;
            const name: []const u8 = if (name_owned)
                (allocator.dupe(u8, entry.name) catch continue)
            else
                blk: {
                    @memcpy(name_storage[0..entry.name.len], entry.name);
                    break :blk name_storage[0..entry.name.len];
                };
            defer if (name_owned) allocator.free(name);

            if (std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..")) continue;
            if (!std.unicode.utf8ValidateSlice(name)) {
                result.summary.files_skipped_invalid_name += 1;
                continue;
            }
            if (entry.kind == .sym_link) {
                result.summary.symlinks_skipped += 1;
                continue;
            }

            path_buf.reset();
            if (rel.len > 0) {
                path_buf.append(rel) catch continue;
                path_buf.append("/") catch continue;
            }
            path_buf.append(name) catch continue;
            const rel_path = path_buf.slice();

            var kind = entry.kind;
            if (kind == .unknown) {
                kind = (dir.statFile(name) catch continue).kind;
            }

            if (kind == .directory) {
                if (!opts.include_hidden and name[0] == '.') {
                    result.summary.directories_skipped += 1;
                    continue;
                }
                if (depth + 1 > opts.max_depth) {
                    result.summary.directories_skipped += 1;
                    continue;
                }
                if (rules.isIgnoredDir(name, rel_path)) {
                    result.summary.directories_skipped += 1;
                    continue;
                }
                const owned = allocator.dupe(u8, rel_path) catch continue;
                stack.append(owned) catch {
                    allocator.free(owned);
                    continue;
                };
                continue;
            }
            if (kind != .file) continue;

            if (!opts.include_hidden and name[0] == '.') {
                result.summary.files_skipped_ignored += 1;
                continue;
            }
            if (rules.isIgnoredFile(name, rel_path)) {
                result.summary.files_skipped_ignored += 1;
                continue;
            }

            const ext_lower = lowerDup(allocator, ignore_mod.extOf(name)) catch continue;
            const dialect = lang.forExtension(ext_lower) orelse {
                allocator.free(ext_lower);
                result.summary.files_skipped_unsupported += 1;
                continue;
            };

            if (files.items.len >= opts.max_files) {
                allocator.free(ext_lower);
                truncated = true;
                break;
            }

            const st = dir.statFile(name) catch {
                allocator.free(ext_lower);
                result.summary.files_skipped_unreadable += 1;
                addWarning(allocator, &warnings, "stat-failed", "could not stat file", rel_path) catch {};
                continue;
            };

            var rec = FileRecord{
                .path = allocator.dupe(u8, rel_path) catch return error.OutOfMemory,
                .ext = ext_lower,
                .language = allocator.dupe(u8, dialect.id) catch return error.OutOfMemory,
                .language_name = allocator.dupe(u8, dialect.name) catch return error.OutOfMemory,
                .bytes = st.size,
                .lines = 0,
                .imports_available = dialect.imports and opts.extract_imports,
                .complexity_available = dialect.complexity and opts.compute_complexity,
            };
            total_bytes += st.size;

            var refs: []imports_mod.ImportRef = &.{};
            const effective_limit: u64 = if (opts.large_file_mode == .full)
                @max(opts.max_file_bytes, 64 * 1024 * 1024)
            else
                opts.max_file_bytes;

            if (st.size == 0) {
                // An empty file has no content to scan, but its complexity is
                // still well defined: zero decision points, so cyclomatic = 1.
                rec.content_scanned = true;
                if (dialect.complexity and opts.compute_complexity) {
                    rec.cyclomatic = 1;
                    rec.branch_count = 0;
                    rec.loop_count = 0;
                    rec.logical_count = 0;
                    rec.max_nesting = 0;
                    rec.function_count = 0;
                    rec.token_count = 0;
                    result.summary.files_with_complexity += 1;
                }
            } else if (st.size > effective_limit) {
                result.summary.files_skipped_large += 1;
                if (opts.large_file_mode == .count_lines) {
                    if (dir.openFile(name, .{})) |fh| {
                        rec.lines = metrics.countPhysicalLines(fh) catch 0;
                        fh.close();
                    } else |_| {}
                }
                addWarning(allocator, &warnings, "file-too-large", "file exceeded the size limit; only metadata and the physical line count were collected", rec.path) catch {};
            } else {
                const content = dir.readFileAlloc(allocator, name, @intCast(st.size)) catch |err| {
                    result.summary.files_skipped_unreadable += 1;
                    addWarning(allocator, &warnings, switch (err) {
                        error.AccessDenied => "file-access-denied",
                        error.IsDir => "file-is-dir",
                        else => "file-read-failed",
                    }, "could not read file contents", rec.path) catch {};
                    files.append(rec) catch return error.OutOfMemory;
                    file_imports.append(&.{}) catch return error.OutOfMemory;
                    continue;
                };
                defer allocator.free(content);

                const counts = analyzer.lineCounts(content, dialect) catch metrics.LineCounts{};
                rec.lines = counts.lines;
                rec.code_lines = counts.code;
                rec.blank_lines = counts.blank;
                rec.comment_lines = counts.comment;
                rec.content_scanned = true;

                if (dialect.complexity and opts.compute_complexity) {
                    const cx = metrics.complexity(content, dialect);
                    rec.cyclomatic = cx.cyclomatic;
                    rec.branch_count = cx.branch_count;
                    rec.loop_count = cx.loop_count;
                    rec.logical_count = cx.logical_count;
                    rec.max_nesting = cx.max_nesting;
                    rec.function_count = cx.function_count;
                    rec.token_count = cx.token_count;
                    result.summary.files_with_complexity += 1;
                }
                if (dialect.imports and opts.extract_imports) {
                    var list = imports_mod.extract(allocator, content, dialect) catch null;
                    if (list) |*l| {
                        // The extracted specifiers point into `content`, which
                        // is freed immediately after this block, so copy them.
                        var owned_refs = std.ArrayList(imports_mod.ImportRef).init(allocator);
                        for (l.items) |item| {
                            const raw = allocator.dupe(u8, item.raw) catch break;
                            owned_refs.append(.{ .raw = raw, .kind = item.kind, .line = item.line }) catch break;
                        }
                        l.deinit();
                        refs = owned_refs.toOwnedSlice() catch emptyRefs(allocator);
                        rec.import_count = @intCast(refs.len);
                    }
                }
            }

            result.summary.total_lines += rec.lines;
            if (rec.code_lines) |c| result.summary.code_lines += c;
            if (rec.blank_lines) |c| result.summary.blank_lines += c;
            if (rec.comment_lines) |c| result.summary.comment_lines += c;

            updateDir(&dir_stats, if (rel.len > 0) rel else "", rec);
            updateLang(allocator, &lang_stats, dialect, rec) catch return error.OutOfMemory;

            fileset.put(allocator, rec.path, @intCast(files.items.len)) catch return error.OutOfMemory;
            files.append(rec) catch return error.OutOfMemory;
            file_imports.append(refs) catch return error.OutOfMemory;

            if (opts.progress) |p| p.emit("walking", files.items.len, total_bytes, dir_stats.count(), false);
            if (total_bytes > opts.max_total_bytes) {
                truncated = true;
                break;
            }
        }
        if (truncated) break;
    }

    if (opts.progress) |p| p.emit("resolving", files.items.len, total_bytes, dir_stats.count(), true);

    // --- resolve import references into edges -------------------------------
    var pb2 = resolve.PathBuf.init(allocator) catch return error.OutOfMemory;
    defer pb2.deinit(allocator);
    for (files.items, file_imports.items, 0..) |file, refs, file_index| {
        if (refs.len == 0) continue;
        result.summary.files_with_imports += 1;
        var resolved_here: u32 = 0;
        for (refs) |ref| {
            const r: resolve.Resolution = if (std.mem.eql(u8, file.language, "python"))
                (resolve.resolvePy(allocator, &fileset, &pb2, file.path, ref.raw, ref.kind == .from_import) catch .{ .path = null, .confidence = .unresolved })
            else
                (resolve.resolveJs(allocator, &fileset, &pb2, file.path, ref.raw) catch .{ .path = null, .confidence = .unresolved });

            switch (r.confidence) {
                .resolved => {
                    result.summary.resolved_edge_count += 1;
                    resolved_here += 1;
                },
                .external => result.summary.external_edge_count += 1,
                .unresolved => result.summary.unresolved_edge_count += 1,
            }
            edges.append(.{
                .from = allocator.dupe(u8, file.path) catch return error.OutOfMemory,
                .to = r.path,
                .raw = allocator.dupe(u8, ref.raw) catch return error.OutOfMemory,
                .kind = allocator.dupe(u8, @tagName(ref.kind)) catch return error.OutOfMemory,
                .confidence = allocator.dupe(u8, @tagName(r.confidence)) catch return error.OutOfMemory,
                .line = ref.line,
            }) catch return error.OutOfMemory;
        }
        files.items[file_index].resolved_import_count = resolved_here;
    }

    // --- deterministic ordering --------------------------------------------
    std.sort.block(FileRecord, files.items, {}, lessFile);
    std.sort.block(Edge, edges.items, {}, lessEdge);

    var lang_list = std.ArrayList(LanguageStat).init(allocator);
    {
        var it = lang_stats.iterator();
        while (it.next()) |kv| lang_list.append(kv.value_ptr.*) catch return error.OutOfMemory;
    }
    std.sort.block(LanguageStat, lang_list.items, {}, lessLang);

    var dir_list = std.ArrayList(DirStat).init(allocator);
    {
        var it = dir_stats.iterator();
        while (it.next()) |kv| dir_list.append(kv.value_ptr.*) catch return error.OutOfMemory;
    }
    std.sort.block(DirStat, dir_list.items, {}, lessDir);

    result.files = files.toOwnedSlice() catch return error.OutOfMemory;
    result.edges = edges.toOwnedSlice() catch return error.OutOfMemory;
    result.languages = lang_list.toOwnedSlice() catch return error.OutOfMemory;
    result.directories = dir_list.toOwnedSlice() catch return error.OutOfMemory;
    result.warnings = warnings.toOwnedSlice() catch return error.OutOfMemory;

    result.summary.file_count = result.files.len;
    result.summary.directory_count = result.directories.len;
    result.summary.total_bytes = total_bytes;
    result.summary.language_count = result.languages.len;
    result.summary.edge_count = result.edges.len;
    result.summary.truncated = truncated;
    result.summary.elapsed_ms = std.time.milliTimestamp() - start_ms;

    if (opts.progress) |p| p.emit("complete", result.files.len, total_bytes, result.directories.len, true);
    return result;
}

// ---------------------------------------------------------------------------

fn findFile(files: []const FileRecord, path: []const u8) ?FileRecord {
    for (files) |f| {
        if (std.mem.eql(u8, f.path, path)) return f;
    }
    return null;
}

fn emptyRefs(allocator: std.mem.Allocator) []imports_mod.ImportRef {
    return allocator.alloc(imports_mod.ImportRef, 0) catch empty: {
        break :empty @as([]imports_mod.ImportRef, &.{});
    };
}

fn countDepth(rel: []const u8) usize {
    if (rel.len == 0) return 0;
    var d: usize = 1;
    for (rel) |c| {
        if (c == '/') d += 1;
    }
    return d;
}

fn addWarning(allocator: std.mem.Allocator, list: *std.ArrayList(Warning), code: []const u8, message: []const u8, path: []const u8) !void {
    if (list.items.len >= 2000) return;
    try list.append(.{
        .code = try allocator.dupe(u8, code),
        .message = try allocator.dupe(u8, message),
        .path = try allocator.dupe(u8, path),
    });
}

fn lowerDup(allocator: std.mem.Allocator, s: []const u8) ![]const u8 {
    const out = try allocator.alloc(u8, s.len);
    for (s, out) |c, *o| o.* = std.ascii.toLower(c);
    return out;
}

fn ensureDir(allocator: std.mem.Allocator, stats: *std.StringHashMap(DirStat), key: []const u8) !void {
    const gop = try stats.getOrPut(key);
    if (!gop.found_existing) {
        const owned = try allocator.dupe(u8, key);
        gop.key_ptr.* = owned;
        gop.value_ptr.* = .{ .path = owned };
    }
}

fn updateDir(stats: *std.StringHashMap(DirStat), key: []const u8, rec: FileRecord) void {
    const v = stats.getPtr(key) orelse return;
    v.file_count += 1;
    v.bytes += rec.bytes;
    v.total_lines += rec.lines;
    if (rec.code_lines) |c| v.code_lines += c;
}

fn updateLang(allocator: std.mem.Allocator, stats: *std.StringHashMap(LanguageStat), d: lang.Dialect, rec: FileRecord) !void {
    const gop = try stats.getOrPut(d.id);
    if (!gop.found_existing) {
        const owned_id = try allocator.dupe(u8, d.id);
        gop.key_ptr.* = owned_id;
        gop.value_ptr.* = .{
            .id = owned_id,
            .name = try allocator.dupe(u8, d.name),
            .complexity_supported = d.complexity,
            .imports_supported = d.imports,
        };
    }
    const v = gop.value_ptr;
    v.file_count += 1;
    v.bytes += rec.bytes;
    v.total_lines += rec.lines;
    if (rec.code_lines) |c| v.code_lines += c;
}

fn lessFile(_: void, a: FileRecord, b: FileRecord) bool {
    return std.mem.lessThan(u8, a.path, b.path);
}

fn lessEdge(_: void, a: Edge, b: Edge) bool {
    if (!std.mem.eql(u8, a.from, b.from)) return std.mem.lessThan(u8, a.from, b.from);
    const at = a.to orelse "";
    const bt = b.to orelse "";
    if (!std.mem.eql(u8, at, bt)) return std.mem.lessThan(u8, at, bt);
    return std.mem.lessThan(u8, a.raw, b.raw);
}

fn lessLang(_: void, a: LanguageStat, b: LanguageStat) bool {
    if (a.bytes != b.bytes) return a.bytes > b.bytes;
    return std.mem.lessThan(u8, a.id, b.id);
}

fn lessDir(_: void, a: DirStat, b: DirStat) bool {
    return std.mem.lessThan(u8, a.path, b.path);
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test "analyze rejects a missing root" {
    const err = analyze(std.testing.allocator, .{ .root = "/definitely/not/a/real/path/riftmap" });
    try std.testing.expectError(error.RootNotFound, err);
}

test "analyze walks a temporary tree and aggregates" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath("src/util");
    try tmp.dir.writeFile(.{ .sub_path = "src/main.ts", .data = "import { helper } from \"./util/helper\";\n\nfunction main() {\n  if (helper()) {\n    return 1;\n  }\n  return 0;\n}\n" });
    try tmp.dir.writeFile(.{ .sub_path = "src/util/helper.ts", .data = "// a helper\nexport function helper(): boolean {\n  return true;\n}\n" });
    try tmp.dir.writeFile(.{ .sub_path = "README.md", .data = "# demo\n" });
    try tmp.dir.makePath("node_modules/dep");
    try tmp.dir.writeFile(.{ .sub_path = "node_modules/dep/index.js", .data = "module.exports = 1;\n" });

    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);

    var res = try analyze(std.testing.allocator, .{ .root = root });
    defer res.deinit();

    try std.testing.expectEqual(@as(usize, 3), res.summary.file_count);
    const main = findFile(res.files, "src/main.ts").?;
    try std.testing.expectEqual(@as(u32, 2), main.cyclomatic.?); // 1 + `if`
    try std.testing.expectEqual(@as(u32, 1), main.function_count.?);
    try std.testing.expectEqual(@as(u32, 8), main.lines);
    try std.testing.expectEqual(@as(usize, 1), res.summary.resolved_edge_count);
    try std.testing.expectEqualStrings("src/util/helper.ts", res.edges[0].to.?);
    try std.testing.expectEqual(@as(usize, 1), res.summary.directories_skipped); // node_modules
}

test "analyze skips the .git directory" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.makePath(".git/objects");
    try tmp.dir.writeFile(.{ .sub_path = ".git/config", .data = "[core]\n" });
    try tmp.dir.writeFile(.{ .sub_path = ".git/objects/blob", .data = "x" });
    try tmp.dir.writeFile(.{ .sub_path = "app.py", .data = "x = 1\n" });

    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    var res = try analyze(std.testing.allocator, .{ .root = root });
    defer res.deinit();
    try std.testing.expectEqual(@as(usize, 1), res.summary.file_count);
    try std.testing.expectEqualStrings("app.py", res.files[0].path);
    try std.testing.expectEqual(@as(usize, 1), res.summary.directories_skipped);
}
