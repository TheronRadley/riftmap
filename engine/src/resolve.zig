//! Specifier resolution for JavaScript/TypeScript and Python imports.
//!
//! Resolution only ever consults the set of files that the scanner actually
//! collected. Nothing is read from disk, so a specifier either maps to a file
//! that was scanned (confidence `resolved`), is clearly a third-party package
//! (confidence `external`), or is reported as `unresolved`.

const std = @import("std");
const lang = @import("language.zig");

pub const Confidence = enum {
    /// Mapped to a file that was included in this scan.
    resolved,
    /// A third-party / standard-library package outside the repository.
    external,
    /// Looks like an internal path but no matching file was found.
    unresolved,
};

pub const str = []const u8;

/// The set of paths collected during the walk.
pub const FileSet = struct {
    map: std.StringHashMap(u32),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) FileSet {
        return .{ .map = std.StringHashMap(u32).init(allocator), .allocator = allocator };
    }
    pub fn deinit(self: *FileSet) void {
        var it = self.map.keyIterator();
        while (it.next()) |key| self.allocator.free(key.*);
        self.map.deinit();
    }
    pub fn put(self: *FileSet, allocator: std.mem.Allocator, path: []const u8, index: u32) !void {
        const owned = try allocator.dupe(u8, path);
        try self.map.put(owned, index);
    }
    pub fn contains(self: *const FileSet, path: []const u8) bool {
        return self.map.contains(path);
    }
};

/// Path scratch buffer so candidate building does not allocate per file.
pub const PathBuf = struct {
    data: []u8,
    len: usize = 0,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) !PathBuf {
        return .{ .data = try allocator.alloc(u8, 8192), .allocator = allocator };
    }
    pub fn deinit(self: *PathBuf, allocator: std.mem.Allocator) void {
        allocator.free(self.data);
    }
    pub fn reset(self: *PathBuf) void {
        self.len = 0;
    }
    pub fn append(self: *PathBuf, s: []const u8) !void {
        if (self.len + s.len > self.data.len) return error.Overflow;
        @memcpy(self.data[self.len .. self.len + s.len], s);
        self.len += s.len;
    }
    pub fn slice(self: *const PathBuf) []const u8 {
        return self.data[0..self.len];
    }
};

/// Join `a` and `b` with a single `/`, normalising `.` and `..` segments.
pub fn normalizeJoin(buf: *PathBuf, a: []const u8, b: []const u8) !void {
    buf.reset();
    var segments = std.ArrayList([]const u8).init(buf.allocator);
    defer segments.deinit();

    var it = std.mem.splitScalar(u8, a, '/');
    while (it.next()) |s| {
        if (s.len == 0 or std.mem.eql(u8, s, ".")) continue;
        if (std.mem.eql(u8, s, "..")) {
            if (segments.items.len > 0) _ = segments.pop();
            continue;
        }
        try segments.append(s);
    }
    var it2 = std.mem.splitScalar(u8, b, '/');
    while (it2.next()) |s| {
        if (s.len == 0 or std.mem.eql(u8, s, ".")) continue;
        if (std.mem.eql(u8, s, "..")) {
            if (segments.items.len > 0) _ = segments.pop();
            continue;
        }
        try segments.append(s);
    }
    for (segments.items, 0..) |s, i| {
        if (i > 0) try buf.append("/");
        try buf.append(s);
    }
}

/// Directory portion of a slash-separated path ("" when there is none).
pub fn dirOf(path: []const u8) []const u8 {
    const idx = std.mem.lastIndexOfScalar(u8, path, '/') orelse return "";
    return path[0..idx];
}

pub const Resolution = struct {
    path: ?[]const u8,
    confidence: Confidence,
};

/// Resolve a JavaScript/TypeScript specifier.
pub fn resolveJs(
    allocator: std.mem.Allocator,
    files: *const FileSet,
    buf: *PathBuf,
    importer: []const u8,
    spec: []const u8,
) !Resolution {
    if (spec.len == 0) return .{ .path = null, .confidence = .unresolved };
    if (std.mem.startsWith(u8, spec, "node:")) return .{ .path = null, .confidence = .external };
    if (!std.mem.startsWith(u8, spec, ".") and !std.mem.startsWith(u8, spec, "/")) {
        return .{ .path = null, .confidence = .external };
    }

    if (std.mem.startsWith(u8, spec, "/")) {
        // Root-relative (bundler / tsconfig baseUrl style).
        if (try tryCandidates(allocator, files, buf, "", spec[1..])) |p| return .{ .path = p, .confidence = .resolved };
        return .{ .path = null, .confidence = .unresolved };
    }

    const base = dirOf(importer);
    if (try tryCandidates(allocator, files, buf, base, spec)) |p| return .{ .path = p, .confidence = .resolved };
    return .{ .path = null, .confidence = .unresolved };
}

fn tryCandidates(allocator: std.mem.Allocator, files: *const FileSet, buf: *PathBuf, base: []const u8, spec: []const u8) !?[]const u8 {
    // 1. exact
    try normalizeJoin(buf, base, spec);
    if (buf.len > 0 and files.contains(buf.slice())) return try dupePath(buf.allocator, buf.slice());

    // 2. with an added extension
    for (lang.JS_RESOLVE_EXTS) |ext| {
        var with_ext = std.ArrayList(u8).init(buf.allocator);
        defer with_ext.deinit();
        try normalizeJoin(buf, base, spec);
        try with_ext.appendSlice(buf.slice());
        try with_ext.appendSlice(ext);
        if (files.contains(with_ext.items)) return try dupePath(allocator, with_ext.items);
    }

    // 3. extension rewriting (.js -> .ts, .jsx -> .tsx, ...)
    for (rewritesFor(spec)) |rw| {
        try normalizeJoin(buf, base, rw.from);
        var rewritten = std.ArrayList(u8).init(buf.allocator);
        defer rewritten.deinit();
        try rewritten.appendSlice(buf.slice());
        try rewritten.appendSlice(rw.to);
        if (files.contains(rewritten.items)) return try dupePath(allocator, rewritten.items);
    }

    // 4. directory index
    for (lang.JS_INDEX_FILES) |idx| {
        var dir_index = std.ArrayList(u8).init(buf.allocator);
        defer dir_index.deinit();
        try normalizeJoin(buf, base, spec);
        try dir_index.appendSlice(buf.slice());
        try dir_index.append('/');
        try dir_index.appendSlice(idx);
        if (files.contains(dir_index.items)) return try dupePath(allocator, dir_index.items);
    }
    return null;
}

const Rewrite = struct { from: []const u8, to: []const u8 };

fn rewritesFor(spec: []const u8) []const Rewrite {
    // Strip the extension so `./foo.js` can resolve to `foo.ts`.
    const dot = std.mem.lastIndexOfScalar(u8, spec, '.');
    if (dot == null) return &[_]Rewrite{};
    const stem = spec[0..dot.?];
    const ext = spec[dot.?..];
    if (std.mem.eql(u8, ext, ".js")) return &[_]Rewrite{ .{ .from = stem, .to = ".ts" }, .{ .from = stem, .to = ".tsx" }, .{ .from = stem, .to = ".jsx" }, .{ .from = stem, .to = ".mjs" }, .{ .from = stem, .to = ".cjs" } };
    if (std.mem.eql(u8, ext, ".mjs")) return &[_]Rewrite{ .{ .from = stem, .to = ".mts" }, .{ .from = stem, .to = ".ts" } };
    if (std.mem.eql(u8, ext, ".cjs")) return &[_]Rewrite{ .{ .from = stem, .to = ".cts" }, .{ .from = stem, .to = ".ts" } };
    if (std.mem.eql(u8, ext, ".jsx")) return &[_]Rewrite{ .{ .from = stem, .to = ".tsx" } };
    return &[_]Rewrite{};
}

fn dupePath(allocator: std.mem.Allocator, p: []const u8) ![]const u8 {
    return allocator.dupe(u8, p);
}

/// Well-known Python standard-library top-level modules. Treated as external
/// rather than unresolved so the UI is not noisy.
const PY_STDLIB = [_][]const u8{
    "abc", "argparse", "array", "ast", "asyncio", "base64", "bisect",
    "builtins", "calendar", "cmath", "collections", "concurrent", "contextlib",
    "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib",
    "enum", "errno", "faulthandler", "fnmatch", "functools", "gc", "getpass",
    "gettext", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http",
    "importlib", "inspect", "io", "itertools", "json", "logging", "math",
    "mimetypes", "multiprocessing", "netrc", "numbers", "operator", "os",
    "pathlib", "pickle", "platform", "pprint", "queue", "random", "re",
    "secrets", "select", "shelve", "shlex", "shutil", "signal", "socket",
    "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
    "sys", "sysconfig", "tarfile", "tempfile", "threading", "time", "timeit",
    "tkinter", "tomllib", "traceback", "types", "typing", "unicodedata",
    "unittest", "urllib", "uuid", "venv", "warnings", "weakref", "webbrowser",
    "xml", "xmlrpc", "zipfile", "zlib", "zoneinfo", "pdb", "profile",
    "pstats", "code", "codeop", "dis", "ast", "symtable", "tabnanny",
    "site", "abc", "contextvars", "graphlib", "int", "fractions",
};

fn isStdlib(top: []const u8) bool {
    for (PY_STDLIB) |m| {
        if (std.mem.eql(u8, m, top)) return true;
    }
    return false;
}

/// Resolve a Python module specifier.
pub fn resolvePy(
    allocator: std.mem.Allocator,
    files: *const FileSet,
    buf: *PathBuf,
    importer: []const u8,
    spec: []const u8,
    kind_is_from: bool,
) !Resolution {
    _ = kind_is_from;
    if (spec.len == 0) return .{ .path = null, .confidence = .unresolved };

    var dots: usize = 0;
    while (dots < spec.len and spec[dots] == '.') : (dots += 1) {}
    const rest = spec[dots..];

    if (dots > 0) {
        // Relative import: walk up from the importing file's directory.
        var base = try allocator.dupe(u8, dirOf(importer));
        defer allocator.free(base);
        var up: usize = dots - 1;
        while (up > 0) : (up -= 1) {
            const parent = dirOf(base);
            const next = try allocator.dupe(u8, parent);
            allocator.free(base);
            base = next;
        }
        if (rest.len == 0) {
            // `from . import x` - the package directory itself.
            try normalizeJoin(buf, base, "__init__.py");
            if (files.contains(buf.slice())) return .{ .path = try allocator.dupe(u8, buf.slice()), .confidence = .resolved };
            return .{ .path = null, .confidence = .unresolved };
        }
        const dotted = try replaceDots(allocator, rest);
        defer allocator.free(dotted);
        if (try tryPyCandidates(allocator, files, buf, base, dotted)) |p| return .{ .path = p, .confidence = .resolved };
    }

    if (dots == 0) {
        const dotted = try replaceDots(allocator, spec);
        defer allocator.free(dotted);
        // 1. next to the importing file (flat scripts / same package)
        if (try tryPyCandidates(allocator, files, buf, dirOf(importer), dotted)) |p| return .{ .path = p, .confidence = .resolved };
        // 2. from the repository root
        if (try tryPyCandidates(allocator, files, buf, "", dotted)) |p| return .{ .path = p, .confidence = .resolved };
        // 3. from any ancestor directory of the importing file
        var base = dirOf(importer);
        while (base.len > 0) {
            if (try tryPyCandidates(allocator, files, buf, base, dotted)) |p| return .{ .path = p, .confidence = .resolved };
            const parent = dirOf(base);
            if (std.mem.eql(u8, parent, base)) break;
            base = parent;
        }
        var top_it = std.mem.splitScalar(u8, dotted, '/');
        const top = top_it.first();
        if (isStdlib(top)) return .{ .path = null, .confidence = .external };
    }

    return .{ .path = null, .confidence = .unresolved };
}

fn tryPyCandidates(allocator: std.mem.Allocator, files: *const FileSet, buf: *PathBuf, base: []const u8, dotted: []const u8) !?[]const u8 {
    var a = std.ArrayList(u8).init(buf.allocator);
    defer a.deinit();
    try normalizeJoin(buf, base, dotted);
    try a.appendSlice(buf.slice());
    try a.appendSlice(".py");
    if (files.contains(a.items)) return try dupePath(allocator, a.items);

    var b = std.ArrayList(u8).init(buf.allocator);
    defer b.deinit();
    b.clearRetainingCapacity();
    try normalizeJoin(buf, base, dotted);
    try b.appendSlice(buf.slice());
    try b.appendSlice("/__init__.py");
    if (files.contains(b.items)) return try dupePath(allocator, b.items);

    var c = std.ArrayList(u8).init(buf.allocator);
    defer c.deinit();
    try normalizeJoin(buf, base, dotted);
    try c.appendSlice(buf.slice());
    try c.appendSlice(".pyi");
    if (files.contains(c.items)) return try dupePath(allocator, c.items);
    return null;
}

fn replaceDots(allocator: std.mem.Allocator, spec: []const u8) ![]const u8 {
    var out = std.ArrayList(u8).init(allocator);
    for (spec) |c| {
        if (c == '.') {
            try out.append('/');
        } else {
            try out.append(c);
        }
    }
    return out.toOwnedSlice();
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

fn makeSet(allocator: std.mem.Allocator, paths: []const []const u8) !FileSet {
    var set = FileSet.init(allocator);
    for (paths, 0..) |p, i| try set.put(allocator, p, @intCast(i));
    return set;
}

test "normalizeJoin collapses dot segments" {
    var buf = try PathBuf.init(std.testing.allocator);
    defer buf.deinit(std.testing.allocator);
    try normalizeJoin(&buf, "src/app", "./util");
    try std.testing.expectEqualStrings("src/app/util", buf.slice());
    try normalizeJoin(&buf, "src/app", "../shared/x");
    try std.testing.expectEqualStrings("src/shared/x", buf.slice());
    try normalizeJoin(&buf, "", "a/./b");
    try std.testing.expectEqualStrings("a/b", buf.slice());
}

test "js resolution: extensions, index files and extension rewriting" {
    const allocator = std.testing.allocator;
    var set = try makeSet(allocator, &[_][]const u8{
        "src/main.ts", "src/util.ts", "src/util.js", "src/comp.tsx",
        "src/legacy.js", "src/legacy.ts", "src/widget/index.ts", "data.json",
    });
    defer set.deinit();
    var buf = try PathBuf.init(allocator);
    defer buf.deinit(allocator);

    var r = try resolveJs(allocator, &set, &buf, "src/main.ts", "./util");
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("src/util.ts", r.path.?);
    allocator.free(r.path.?);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "./comp");
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("src/comp.tsx", r.path.?);
    allocator.free(r.path.?);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "./widget");
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("src/widget/index.ts", r.path.?);
    allocator.free(r.path.?);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "../data.json");
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("data.json", r.path.?);
    allocator.free(r.path.?);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "react");
    try std.testing.expect(r.path == null);
    try std.testing.expectEqual(Confidence.external, r.confidence);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "./missing");
    try std.testing.expect(r.path == null);
    try std.testing.expectEqual(Confidence.unresolved, r.confidence);

    r = try resolveJs(allocator, &set, &buf, "src/main.ts", "node:fs");
    try std.testing.expectEqual(Confidence.external, r.confidence);
}

test "python resolution: relative levels and packages" {
    const allocator = std.testing.allocator;
    var set = try makeSet(allocator, &[_][]const u8{
        "pkg/__init__.py", "pkg/mod.py", "pkg/sub/__init__.py",
        "pkg/sub/deep.py", "top.py", "other/__init__.py",
    });
    defer set.deinit();
    var buf = try PathBuf.init(allocator);
    defer buf.deinit(allocator);

    var r = try resolvePy(allocator, &set, &buf, "pkg/mod.py", "pkg.sub.deep", false);
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("pkg/sub/deep.py", r.path.?);
    allocator.free(r.path.?);

    r = try resolvePy(allocator, &set, &buf, "pkg/sub/deep.py", "..mod", false);
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("pkg/mod.py", r.path.?);
    allocator.free(r.path.?);

    r = try resolvePy(allocator, &set, &buf, "pkg/sub/deep.py", ".", true);
    try std.testing.expectEqual(Confidence.resolved, r.confidence);
    try std.testing.expectEqualStrings("pkg/sub/__init__.py", r.path.?);
    allocator.free(r.path.?);

    r = try resolvePy(allocator, &set, &buf, "top.py", "os", false);
    try std.testing.expect(r.path == null);
    try std.testing.expectEqual(Confidence.external, r.confidence);

    r = try resolvePy(allocator, &set, &buf, "top.py", "nonexistent_thing", false);
    try std.testing.expectEqual(Confidence.unresolved, r.confidence);
}
