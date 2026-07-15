part of cozypad;

/* =========================================================
   Hermes Native Studio
========================================================= */

enum _HermesStudioSection {
  overview,
  settings,
  session,
  memory,
  skills,
  automations,
  gateways,
  profiles,
  dlOps,
  security,
}

class _HermesFeatureSpec {
  final String title;
  final String description;
  final IconData icon;
  final String status;

  const _HermesFeatureSpec({
    required this.title,
    required this.description,
    required this.icon,
    required this.status,
  });
}

class HermesApiProfile {
  final String id;
  final String name;
  final String baseUrl;
  final String model;
  final String limitLabel;
  final List<String> supportedModels;

  const HermesApiProfile({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.model,
    required this.limitLabel,
    this.supportedModels = const [],
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'baseUrl': baseUrl,
      'model': model,
      'limitLabel': limitLabel,
      'supportedModels': supportedModels,
    };
  }

  factory HermesApiProfile.fromJson(Map<String, dynamic> json) {
    final listRaw = json['supportedModels'];
    final supported = listRaw is List
        ? listRaw.map((e) => e.toString()).toList()
        : <String>[];
    return HermesApiProfile(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      baseUrl: json['baseUrl']?.toString() ?? '',
      model: json['model']?.toString() ?? '',
      limitLabel: json['limitLabel']?.toString() ?? '',
      supportedModels: supported,
    );
  }

  HermesApiProfile copyWith({
    String? model,
    List<String>? supportedModels,
  }) {
    return HermesApiProfile(
      id: id,
      name: name,
      baseUrl: baseUrl,
      model: model ?? this.model,
      limitLabel: limitLabel,
      supportedModels: supportedModels ?? this.supportedModels,
    );
  }
}

class HermesSettings {
  final String model;
  final String baseUrl;
  final String apiKey;
  final String hermesHome;
  final String soul;
  final String profile;
  final String project;
  final bool allowRemoteTools;
  final bool requireApprovalDestructive;
  final bool requireApprovalGpuPreempt;
  final bool requireApprovalMultiGpu;

  const HermesSettings({
    required this.model,
    required this.baseUrl,
    required this.apiKey,
    required this.hermesHome,
    required this.soul,
    required this.profile,
    required this.project,
    required this.allowRemoteTools,
    required this.requireApprovalDestructive,
    required this.requireApprovalGpuPreempt,
    required this.requireApprovalMultiGpu,
  });
}

class HermesTurnInput {
  final String text;
  final SSHProvider dashboard;
  final HermesSettings settings;

  const HermesTurnInput({
    required this.text,
    required this.dashboard,
    required this.settings,
  });
}

class HermesMessagePart {
  final String type;
  final String text;
  final Map<String, dynamic> metadata;

  const HermesMessagePart({
    required this.type,
    required this.text,
    this.metadata = const {},
  });

  factory HermesMessagePart.text(String text) {
    return HermesMessagePart(type: 'text', text: text);
  }

  factory HermesMessagePart.toolCall({
    required String tool,
    required Map<String, dynamic> args,
    required String reason,
  }) {
    return HermesMessagePart(
      type: 'tool_call',
      text: reason,
      metadata: {
        'tool': tool,
        'args': args,
      },
    );
  }

  factory HermesMessagePart.toolResult({
    required String tool,
    required bool ok,
    required String output,
  }) {
    return HermesMessagePart(
      type: 'tool_result',
      text: output,
      metadata: {
        'tool': tool,
        'ok': ok,
      },
    );
  }

  factory HermesMessagePart.error(String text) {
    return HermesMessagePart(type: 'error', text: text);
  }

  factory HermesMessagePart.trace(String text, {String kind = 'model_visible_notes'}) {
    return HermesMessagePart(
      type: 'trace',
      text: text,
      metadata: {
        'kind': kind,
      },
    );
  }

  factory HermesMessagePart.clarification({
    required String question,
    List<String> options = const [],
    String reason = '',
  }) {
    return HermesMessagePart(
      type: 'clarification',
      text: question,
      metadata: {
        'options': options,
        'reason': reason,
      },
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'text': text,
      'metadata': metadata,
    };
  }

  factory HermesMessagePart.fromJson(dynamic raw) {
    if (raw is! Map) return HermesMessagePart.text(raw?.toString() ?? '');
    final metadata = raw['metadata'] is Map
        ? Map<String, dynamic>.from(raw['metadata'] as Map)
        : <String, dynamic>{};
    return HermesMessagePart(
      type: raw['type']?.toString() ?? 'text',
      text: raw['text']?.toString() ?? '',
      metadata: metadata,
    );
  }
}

class HermesMessage {
  final String id;
  final String role;
  final List<HermesMessagePart> parts;
  final DateTime createdAt;

  HermesMessage({
    String? id,
    required this.role,
    required this.parts,
    DateTime? createdAt,
  })  : id = id ?? DateTime.now().microsecondsSinceEpoch.toString(),
        createdAt = createdAt ?? DateTime.now();

  String get plainText {
    return parts.map((part) => part.text).where((text) => text.trim().isNotEmpty).join('\n');
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'role': role,
      'parts': parts.map((part) => part.toJson()).toList(),
      'createdAt': createdAt.toIso8601String(),
    };
  }

  factory HermesMessage.fromJson(dynamic raw) {
    if (raw is! Map) {
      return HermesMessage(role: 'system', parts: [HermesMessagePart.text(raw?.toString() ?? '')]);
    }
    final partsRaw = raw['parts'];
    final parts = partsRaw is List
        ? partsRaw.map(HermesMessagePart.fromJson).toList()
        : [HermesMessagePart.text(raw['text']?.toString() ?? '')];
    return HermesMessage(
      id: raw['id']?.toString(),
      role: raw['role']?.toString() ?? 'assistant',
      parts: parts,
      createdAt: DateTime.tryParse(raw['createdAt']?.toString() ?? '') ?? DateTime.now(),
    );
  }
}

class HermesSession {
  final String id;
  String title;
  String profile;
  String project;
  String? connectedHost;
  String? frozenMemoryPrompt;
  final DateTime createdAt;
  DateTime updatedAt;
  final List<HermesMessage> messages;

  HermesSession({
    String? id,
    required this.title,
    required this.profile,
    required this.project,
    this.connectedHost,
    this.frozenMemoryPrompt,
    DateTime? createdAt,
    DateTime? updatedAt,
    List<HermesMessage>? messages,
  })  : id = id ?? DateTime.now().microsecondsSinceEpoch.toString(),
        createdAt = createdAt ?? DateTime.now(),
        updatedAt = updatedAt ?? DateTime.now(),
        messages = messages ?? [];

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'profile': profile,
      'project': project,
      'connectedHost': connectedHost,
      'frozenMemoryPrompt': frozenMemoryPrompt,
      'createdAt': createdAt.toIso8601String(),
      'updatedAt': updatedAt.toIso8601String(),
      'messages': messages.map((message) => message.toJson()).toList(),
    };
  }

  factory HermesSession.fromJson(dynamic raw) {
    if (raw is! Map) {
      return HermesSession(title: 'Default session', profile: 'default', project: 'general');
    }
    final messagesRaw = raw['messages'];
    return HermesSession(
      id: raw['id']?.toString(),
      title: raw['title']?.toString() ?? 'Default session',
      profile: raw['profile']?.toString() ?? 'default',
      project: raw['project']?.toString() ?? 'general',
      connectedHost: raw['connectedHost']?.toString(),
      frozenMemoryPrompt: raw['frozenMemoryPrompt']?.toString(),
      createdAt: DateTime.tryParse(raw['createdAt']?.toString() ?? '') ?? DateTime.now(),
      updatedAt: DateTime.tryParse(raw['updatedAt']?.toString() ?? '') ?? DateTime.now(),
      messages: messagesRaw is List
          ? messagesRaw.map(HermesMessage.fromJson).toList()
          : <HermesMessage>[],
    );
  }
}

class HermesSessionStore {
  String homePath;
  HermesSession? activeSession;
  String? lastError;

  HermesSessionStore({required this.homePath});

  io.Directory _sessionDir(String profile, String project, {String? connectedHost}) {
    final safeProfile = _safeName(profile.trim().isEmpty ? 'default' : profile.trim());
    final safeProject = _safeName(project.trim().isEmpty ? 'general' : project.trim());
    final hostDir = connectedHost != null && connectedHost.trim().isNotEmpty
        ? _safeName(connectedHost.trim())
        : 'local';
    final root = _expandedHome(homePath);
    return io.Directory('$root/sessions/$safeProfile/$safeProject/$hostDir');
  }

  io.File _sessionFile(String profile, String project, String sessionId, {String? connectedHost}) {
    final dir = _sessionDir(profile, project, connectedHost: connectedHost);
    final safeSessionId = _safeName(sessionId.trim().isEmpty ? 'default' : sessionId.trim());
    return io.File('${dir.path}/session_$safeSessionId.json');
  }

  Future<void> _migrateLegacySession(String profile, String project) async {
    if (kIsWeb) return;
    try {
      final dir = _sessionDir(profile, project);
      final legacyFile = io.File('${dir.path}/default_session.json');
      if (await legacyFile.exists()) {
        final raw = await legacyFile.readAsString();
        final session = HermesSession.fromJson(jsonDecode(raw));
        final newFile = _sessionFile(profile, project, session.id);
        if (!await newFile.exists()) {
          await newFile.parent.create(recursive: true);
          await newFile.writeAsString(raw);
        }
        await legacyFile.delete();
      }
    } catch (_) {}
  }

  Future<void> load({
    required String profile,
    required String project,
    String? connectedHost,
    String? sessionId,
  }) async {
    lastError = null;
    if (kIsWeb) {
      activeSession ??= _newSession(profile: profile, project: project, connectedHost: connectedHost);
      return;
    }

    try {
      await _migrateLegacySession(profile, project);
      final dir = _sessionDir(profile, project, connectedHost: connectedHost);
      if (sessionId != null && sessionId.trim().isNotEmpty) {
        final file = _sessionFile(profile, project, sessionId, connectedHost: connectedHost);
        if (await file.exists()) {
          final raw = await file.readAsString();
          activeSession = HermesSession.fromJson(jsonDecode(raw));
          activeSession!.connectedHost = connectedHost;
          activeSession!.updatedAt = DateTime.now();
          await save();
          return;
        }
      }

      // Fallback: search directory for session files
      if (await dir.exists()) {
        final files = await dir
            .list()
            .where((entity) => entity is io.File && entity.path.endsWith('.json'))
            .cast<io.File>()
            .toList();
        if (files.isNotEmpty) {
          // Sort by last modified
          files.sort((a, b) => b.lastModifiedSync().compareTo(a.lastModifiedSync()));
          final raw = await files.first.readAsString();
          activeSession = HermesSession.fromJson(jsonDecode(raw));
          activeSession!.connectedHost = connectedHost;
          activeSession!.updatedAt = DateTime.now();
          await save();
          return;
        }
      }

      // No files found, create default one
      activeSession = _newSession(profile: profile, project: project, connectedHost: connectedHost);
      await save();
    } catch (e) {
      lastError = e.toString();
      activeSession = _newSession(profile: profile, project: project, connectedHost: connectedHost);
    }
  }

  Future<void> save() async {
    final session = activeSession;
    if (session == null || kIsWeb) return;
    try {
      session.updatedAt = DateTime.now();
      final file = _sessionFile(session.profile, session.project, session.id, connectedHost: session.connectedHost);
      await file.parent.create(recursive: true);
      const encoder = JsonEncoder.withIndent('  ');
      await file.writeAsString(encoder.convert(session.toJson()));
      lastError = null;
    } catch (e) {
      lastError = e.toString();
    }
  }

  Future<void> newSession({
    required String profile,
    required String project,
    String? connectedHost,
  }) async {
    activeSession = _newSession(profile: profile, project: project, connectedHost: connectedHost);
    await save();
  }

  Future<List<HermesSession>> listSessions({
    required String profile,
    required String project,
    String? connectedHost,
  }) async {
    if (kIsWeb) return activeSession != null ? [activeSession!] : [];
    try {
      await _migrateLegacySession(profile, project);
      final dir = _sessionDir(profile, project, connectedHost: connectedHost);
      if (!await dir.exists()) return [];
      final files = await dir
          .list()
          .where((entity) => entity is io.File && entity.path.endsWith('.json'))
          .cast<io.File>()
          .toList();
      final sessionsList = <HermesSession>[];
      final seenIds = <String>{};
      for (final file in files) {
        try {
          final raw = await file.readAsString();
          final session = HermesSession.fromJson(jsonDecode(raw));
          if (!seenIds.contains(session.id)) {
            seenIds.add(session.id);
            sessionsList.add(session);
          }
        } catch (_) {}
      }
      sessionsList.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
      return sessionsList;
    } catch (e) {
      return [];
    }
  }

  Future<void> deleteSession({
    required String profile,
    required String project,
    required String sessionId,
    String? connectedHost,
  }) async {
    if (kIsWeb) return;
    try {
      final file = _sessionFile(profile, project, sessionId, connectedHost: connectedHost);
      if (await file.exists()) {
        await file.delete();
      }
      final dir = _sessionDir(profile, project, connectedHost: connectedHost);
      final legacyFile = io.File('${dir.path}/default_session.json');
      if (await legacyFile.exists()) {
        try {
          final raw = await legacyFile.readAsString();
          final session = HermesSession.fromJson(jsonDecode(raw));
          if (session.id == sessionId) {
            await legacyFile.delete();
          }
        } catch (_) {}
      }
      if (activeSession?.id == sessionId) {
        activeSession = null;
        await load(profile: profile, project: project, connectedHost: connectedHost);
      }
    } catch (e) {
      lastError = e.toString();
    }
  }

  HermesSession _newSession({
    required String profile,
    required String project,
    String? connectedHost,
  }) {
    final timestamp = DateTime.now().millisecondsSinceEpoch.toString();
    final dateStr = DateTime.now().toIso8601String().substring(0, 16).replaceAll('T', ' ');
    return HermesSession(
      id: timestamp,
      title: 'Session ($dateStr)',
      profile: profile.trim().isEmpty ? 'default' : profile.trim(),
      project: project.trim().isEmpty ? 'general' : project.trim(),
      connectedHost: connectedHost,
    );
  }

  List<Map<String, dynamic>> searchLoadedMessages(String query, {int limit = 8}) {
    final session = activeSession;
    if (session == null) return const <Map<String, dynamic>>[];
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return const <Map<String, dynamic>>[];
    final matches = <Map<String, dynamic>>[];
    for (final message in session.messages.reversed) {
      final text = message.parts.map((part) => part.text).join('\n').trim();
      if (text.toLowerCase().contains(q)) {
        matches.add({
          'role': message.role,
          'created_at': message.createdAt.toIso8601String(),
          'text': text.length > 1200 ? '${text.substring(0, 1200)}…' : text,
        });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }

  io.File _sessionFileForFallbackCompat(String profile, String project) {
    final safeProfile = _safeName(profile.trim().isEmpty ? 'default' : profile.trim());
    final safeProject = _safeName(project.trim().isEmpty ? 'general' : project.trim());
    final root = _expandedHome(homePath);
    return io.File('$root/sessions/$safeProfile/$safeProject/default_session.json');
  }

  String _safeName(String value) {
    return value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '_');
  }

  String _expandedHome(String raw) {
    var path = raw.trim();
    if (path.isEmpty) path = _defaultRoot();
    if (path.startsWith('%APPDATA%') && !kIsWeb && io.Platform.isWindows) {
      final appData = io.Platform.environment['APPDATA'];
      if (appData != null && appData.isNotEmpty) {
        path = path.replaceFirst('%APPDATA%', appData);
      }
    }
    if (path == '~' || path.startsWith('~/')) {
      final home = !kIsWeb ? io.Platform.environment['HOME'] : null;
      if (home != null && home.isNotEmpty) {
        path = path == '~' ? home : '$home/${path.substring(2)}';
      }
    }
    return path;
  }

  String _defaultRoot() {
    if (!kIsWeb && io.Platform.isWindows) {
      return '${io.Platform.environment['APPDATA'] ?? '.'}\\cozypad_hermes';
    }
    return '${!kIsWeb ? io.Platform.environment['HOME'] ?? '.' : '.'}/.cozypad_hermes';
  }
}


class HermesMemoryEntry {
  final String text;

  const HermesMemoryEntry(this.text);
}

class HermesMemoryTargetState {
  final String target;
  final String fileName;
  final int limit;
  final List<String> entries;

  const HermesMemoryTargetState({
    required this.target,
    required this.fileName,
    required this.limit,
    required this.entries,
  });

  int get usedChars => entries.join('\n§\n').length;
  int get percent => limit <= 0 ? 0 : ((usedChars / limit) * 100).round().clamp(0, 999).toInt();
  bool get isNearCapacity => usedChars >= (limit * 0.80).round();
}

class HermesMemorySnapshot {
  final HermesMemoryTargetState memory;
  final HermesMemoryTargetState general;
  final HermesMemoryTargetState user;

  const HermesMemorySnapshot({
    required this.memory,
    required this.general,
    required this.user,
  });

  HermesMemoryTargetState target(String value) {
    final clean = value.trim().toLowerCase();
    if (clean == 'user') return user;
    if (clean == 'general') return general;
    return memory;
  }

  bool get isEmpty => memory.entries.isEmpty && general.entries.isEmpty && user.entries.isEmpty;

  String formatForPrompt() {
    final blocks = <String>[];
    if (general.entries.isNotEmpty) {
      blocks.add(_formatBlock(general, 'GENERAL MEMORY (global notes)'));
    }
    if (memory.entries.isNotEmpty) {
      blocks.add(_formatBlock(memory, 'PROJECT MEMORY (project-specific notes)'));
    }
    if (user.entries.isNotEmpty) {
      blocks.add(_formatBlock(user, 'USER PROFILE'));
    }
    return blocks.join('\n\n');
  }

  String _formatBlock(HermesMemoryTargetState state, String title) {
    final border = '══════════════════════════════════════════════';
    final buffer = StringBuffer();
    buffer.writeln(border);
    buffer.writeln('$title [${state.percent}% — ${state.usedChars}/${state.limit} chars]');
    buffer.writeln(border);
    buffer.write(state.entries.join('\n§\n'));
    return buffer.toString().trimRight();
  }
}

class HermesMemoryToolResult {
  final bool success;
  final String output;
  final HermesMemorySnapshot snapshot;
  final bool mutated;

  const HermesMemoryToolResult({
    required this.success,
    required this.output,
    required this.snapshot,
    this.mutated = false,
  });
}

/// Dashboard-native implementation of Hermes' built-in memory shape:
/// ~/.hermes/memories/MEMORY.md + USER.md, bounded character stores, section-sign
/// delimiters, and memory(action=add|replace|remove, target=memory|user|general).
class HermesMemoryStore {
  String homePath;
  String profile;
  String project;
  String? lastError;

  static const int memoryCharLimit = 2200;
  static const int generalCharLimit = 2200;
  static const int userCharLimit = 1375;
  static const String delimiter = '§';

  HermesMemoryStore({
    required this.homePath,
    this.profile = 'default',
    this.project = 'general',
  });

  Future<HermesMemorySnapshot> loadSnapshot() async {
    final memoryEntries = await _readEntries('memory');
    final generalEntries = await _readEntries('general');
    final userEntries = await _readEntries('user');
    return HermesMemorySnapshot(
      memory: HermesMemoryTargetState(
        target: 'memory',
        fileName: 'MEMORY.md',
        limit: memoryCharLimit,
        entries: memoryEntries,
      ),
      general: HermesMemoryTargetState(
        target: 'general',
        fileName: 'MEMORY.md',
        limit: generalCharLimit,
        entries: generalEntries,
      ),
      user: HermesMemoryTargetState(
        target: 'user',
        fileName: 'USER.md',
        limit: userCharLimit,
        entries: userEntries,
      ),
    );
  }

  Future<HermesMemoryToolResult> applyTool(Map<String, dynamic> args) async {
    final action = args['action']?.toString().trim().toLowerCase() ?? '';
    final target = _normalizeTarget(args['target']?.toString() ?? args['store']?.toString() ?? 'memory');
    final content = args['content']?.toString().trim() ?? '';
    final oldText = args['old_text']?.toString().trim() ??
        args['oldText']?.toString().trim() ??
        args['substring']?.toString().trim() ??
        '';
    final before = await loadSnapshot();

    if (!['add', 'replace', 'remove'].contains(action)) {
      return HermesMemoryToolResult(
        success: false,
        output: _json({
          'success': false,
          'error': 'Invalid memory action "$action". Use add, replace, or remove.',
          'allowed_actions': ['add', 'replace', 'remove'],
        }),
        snapshot: before,
      );
    }

    if (action == 'add') {
      return _add(target: target, content: content);
    }
    if (action == 'replace') {
      return _replace(target: target, oldText: oldText, content: content);
    }
    return _remove(target: target, oldText: oldText);
  }

  Future<HermesMemoryToolResult> add({
    required String target,
    required String content,
  }) {
    return _add(target: _normalizeTarget(target), content: content);
  }

  Future<HermesMemoryToolResult> replace({
    required String target,
    required String oldText,
    required String content,
  }) {
    return _replace(target: _normalizeTarget(target), oldText: oldText, content: content);
  }

  Future<HermesMemoryToolResult> remove({
    required String target,
    required String oldText,
  }) {
    return _remove(target: _normalizeTarget(target), oldText: oldText);
  }

  Future<HermesMemoryToolResult> _add({
    required String target,
    required String content,
  }) async {
    final clean = _cleanEntry(content);
    final snapshot = await loadSnapshot();
    final state = snapshot.target(target);
    if (clean.isEmpty) {
      return _error(snapshot, 'Cannot add an empty memory entry.');
    }

    final scanError = _scanSecurity(clean);
    if (scanError != null) return _error(snapshot, scanError);

    final entries = List<String>.from(state.entries);
    if (entries.any((entry) => entry.trim() == clean.trim())) {
      return HermesMemoryToolResult(
        success: true,
        mutated: false,
        snapshot: snapshot,
        output: _json({
          'success': true,
          'duplicate': true,
          'message': 'Exact duplicate already exists; no duplicate added.',
          'target': target,
          'usage': '${state.usedChars}/${state.limit}',
        }),
      );
    }

    final newEntries = [...entries, clean];
    final newUsed = _joinedLength(newEntries);
    if (newUsed > state.limit) {
      return _error(
        snapshot,
        '${target.toUpperCase()} at ${state.usedChars}/${state.limit} chars. Adding this entry (${clean.length} chars) would exceed the limit. Replace or remove existing entries first.',
        extra: {
          'current_entries': entries,
          'usage': '${state.usedChars}/${state.limit}',
        },
      );
    }

    await _writeEntries(target, newEntries);
    final after = await loadSnapshot();
    return HermesMemoryToolResult(
      success: true,
      mutated: true,
      snapshot: after,
      output: _json({
        'success': true,
        'action': 'add',
        'target': target,
        'usage': '${after.target(target).usedChars}/${after.target(target).limit}',
        'message': 'Memory entry added. It is persisted now but will be injected into the system prompt on the next session snapshot.',
      }),
    );
  }

  Future<HermesMemoryToolResult> _replace({
    required String target,
    required String oldText,
    required String content,
  }) async {
    final cleanOld = oldText.trim();
    final cleanContent = _cleanEntry(content);
    final snapshot = await loadSnapshot();
    final state = snapshot.target(target);

    if (cleanOld.isEmpty) {
      return _error(snapshot, 'old_text is required for memory replace.');
    }
    if (cleanContent.isEmpty) {
      return _error(snapshot, 'content is required for memory replace.');
    }

    final scanError = _scanSecurity(cleanContent);
    if (scanError != null) return _error(snapshot, scanError);

    final matches = <int>[];
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].contains(cleanOld)) matches.add(i);
    }
    if (matches.isEmpty) {
      return _error(snapshot, 'No ${target.toUpperCase()} entry contains old_text: "$cleanOld".');
    }
    if (matches.length > 1) {
      return _error(snapshot, 'old_text matched ${matches.length} entries. Use a more specific substring.');
    }

    final entries = List<String>.from(state.entries);
    entries[matches.single] = cleanContent;
    final newUsed = _joinedLength(entries);
    if (newUsed > state.limit) {
      return _error(snapshot, 'Replacement would exceed ${target.toUpperCase()} limit: $newUsed/${state.limit} chars.');
    }

    await _writeEntries(target, entries);
    final after = await loadSnapshot();
    return HermesMemoryToolResult(
      success: true,
      mutated: true,
      snapshot: after,
      output: _json({
        'success': true,
        'action': 'replace',
        'target': target,
        'usage': '${after.target(target).usedChars}/${after.target(target).limit}',
      }),
    );
  }

  Future<HermesMemoryToolResult> _remove({
    required String target,
    required String oldText,
  }) async {
    final cleanOld = oldText.trim();
    final snapshot = await loadSnapshot();
    final state = snapshot.target(target);

    if (cleanOld.isEmpty) {
      return _error(snapshot, 'old_text is required for memory remove.');
    }

    final matches = <int>[];
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].contains(cleanOld)) matches.add(i);
    }
    if (matches.isEmpty) {
      return _error(snapshot, 'No ${target.toUpperCase()} entry contains old_text: "$cleanOld".');
    }
    if (matches.length > 1) {
      return _error(snapshot, 'old_text matched ${matches.length} entries. Use a more specific substring.');
    }

    final entries = List<String>.from(state.entries)..removeAt(matches.single);
    await _writeEntries(target, entries);
    final after = await loadSnapshot();
    return HermesMemoryToolResult(
      success: true,
      mutated: true,
      snapshot: after,
      output: _json({
        'success': true,
        'action': 'remove',
        'target': target,
        'usage': '${after.target(target).usedChars}/${after.target(target).limit}',
      }),
    );
  }

  Future<List<String>> _readEntries(String target) async {
    if (kIsWeb) return const <String>[];
    try {
      final file = _memoryFile(target);
      if (!await file.exists()) return const <String>[];
      final raw = await file.readAsString();
      return _splitEntries(raw);
    } catch (e) {
      lastError = e.toString();
      return const <String>[];
    }
  }

  Future<void> _writeEntries(String target, List<String> entries) async {
    if (kIsWeb) return;
    final file = _memoryFile(target);
    await file.parent.create(recursive: true);
    final content = entries.map(_cleanEntry).where((entry) => entry.isNotEmpty).join('\n$delimiter\n');
    await file.writeAsString(content.isEmpty ? '' : '$content\n', flush: true);
    lastError = null;
  }

  List<String> _splitEntries(String raw) {
    return raw
        .split(RegExp(r'\n\s*§\s*\n|^\s*§\s*$', multiLine: true))
        .map(_cleanEntry)
        .where((entry) => entry.isNotEmpty)
        .toList();
  }

  String _cleanEntry(String value) {
    return value
        .replaceAll('\r\n', '\n')
        .replaceAll(RegExp(r'\n{3,}'), '\n\n')
        .trim();
  }

  String? _scanSecurity(String value) {
    final lower = value.toLowerCase();
    final invisible = RegExp(r'[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]');
    if (invisible.hasMatch(value)) {
      return 'Memory entry rejected: invisible Unicode control characters are not allowed.';
    }
    final risky = [
      'ignore previous instructions',
      'ignore all previous instructions',
      'system prompt',
      'developer message',
      'exfiltrate',
      'steal',
      'send my api key',
      'send api key',
      'private key',
      'ssh-rsa',
      'begin openssh private key',
      'curl ',
      'wget ',
      'nc ',
      'netcat',
      'reverse shell',
      'authorized_keys',
    ];
    if (risky.any(lower.contains)) {
      return 'Memory entry rejected: content looks like prompt injection, credential exfiltration, or remote shell persistence.';
    }
    return null;
  }

  int _joinedLength(List<String> entries) => entries.join('\n$delimiter\n').length;

  HermesMemoryToolResult _error(
    HermesMemorySnapshot snapshot,
    String message, {
    Map<String, dynamic> extra = const {},
  }) {
    return HermesMemoryToolResult(
      success: false,
      snapshot: snapshot,
      output: _json({
        'success': false,
        'error': message,
        ...extra,
      }),
    );
  }

  String _normalizeTarget(String value) {
    final clean = value.trim().toLowerCase();
    if (clean == 'user' || clean == 'user_profile' || clean == 'profile') return 'user';
    if (clean == 'general' || clean == 'global' || clean == 'common') return 'general';
    return 'memory';
  }

  String _safeName(String value) {
    return value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '_');
  }

  io.File _memoryFile(String target) {
    final root = _expandedHome(homePath);
    final norm = _normalizeTarget(target);
    if (norm == 'user') {
      final newFile = io.File('$root/memories/general/USER.md');
      final oldFile = io.File('$root/memories/USER.md');
      if (oldFile.existsSync() && !newFile.existsSync()) {
        try {
          newFile.parent.createSync(recursive: true);
          oldFile.copySync(newFile.path);
          oldFile.deleteSync();
        } catch (_) {}
      }
      return newFile;
    } else if (norm == 'general') {
      final newFile = io.File('$root/memories/general/MEMORY.md');
      final oldFile = io.File('$root/memories/MEMORY.md');
      if (oldFile.existsSync() && !newFile.existsSync()) {
        try {
          newFile.parent.createSync(recursive: true);
          oldFile.copySync(newFile.path);
          oldFile.deleteSync();
        } catch (_) {}
      }
      return newFile;
    } else {
      final safeProfile = _safeName(profile.trim().isEmpty ? 'default' : profile.trim());
      final safeProject = _safeName(project.trim().isEmpty ? 'general' : project.trim());
      return io.File('$root/memories/projects/$safeProfile/$safeProject/MEMORY.md');
    }
  }

  String _expandedHome(String raw) {
    var path = raw.trim();
    if (path.isEmpty) path = _defaultRoot();
    if (path.startsWith('%APPDATA%') && !kIsWeb && io.Platform.isWindows) {
      final appData = io.Platform.environment['APPDATA'];
      if (appData != null && appData.isNotEmpty) {
        path = path.replaceFirst('%APPDATA%', appData);
      }
    }
    if (path == '~' || path.startsWith('~/')) {
      final home = !kIsWeb ? io.Platform.environment['HOME'] : null;
      if (home != null && home.isNotEmpty) {
        path = path == '~' ? home : '$home/${path.substring(2)}';
      }
    }
    return path;
  }

  String _defaultRoot() {
    if (!kIsWeb && io.Platform.isWindows) {
      return '${io.Platform.environment['APPDATA'] ?? '.'}\\cozypad_hermes';
    }
    return '${!kIsWeb ? io.Platform.environment['HOME'] ?? '.' : '.'}/.cozypad_hermes';
  }

  String _json(Map<String, dynamic> value) {
    return const JsonEncoder.withIndent('  ').convert(value);
  }
}

class HermesToolCall {
  final String tool;
  final Map<String, dynamic> args;
  final String reason;

  const HermesToolCall({
    required this.tool,
    required this.args,
    required this.reason,
  });
}

class HermesToolResult {
  final String tool;
  final bool ok;
  final String output;
  final Map<String, dynamic> data;

  const HermesToolResult({
    required this.tool,
    required this.ok,
    required this.output,
    this.data = const {},
  });
}

class HermesApprovalDecision {
  final bool allowed;
  final String risk;
  final String reason;

  const HermesApprovalDecision({
    required this.allowed,
    required this.risk,
    required this.reason,
  });
}

class HermesApprovalPolicy {
  HermesApprovalDecision evaluate(HermesToolCall call, HermesSettings settings) {
    if (call.tool == 'memory') {
      return const HermesApprovalDecision(allowed: true, risk: 'low', reason: 'Hermes built-in memory tool with bounded MEMORY.md / USER.md stores.');
    }

    if (call.tool == 'dashboard.context' || call.tool == 'gpu.snapshot' || call.tool == 'task.list') {
      return const HermesApprovalDecision(allowed: true, risk: 'low', reason: 'Read-only dashboard state.');
    }

    if (call.tool == 'file.list' || call.tool == 'file.read_text') {
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools,
        risk: 'low',
        reason: settings.allowRemoteTools ? 'Read-only remote file inspection.' : 'Remote tools are disabled in settings.',
      );
    }

    if (call.tool == 'ssh.run_readonly') {
      final command = call.args['command']?.toString() ?? '';
      final readOnly = _isReadOnlyCommand(command);
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools && readOnly,
        risk: readOnly ? 'medium' : 'high',
        reason: readOnly
            ? 'Read-only SSH command through dashboard adapter.'
            : 'Command is not classified as read-only; use ssh.run_approved with explicit approval.',
      );
    }

    if (call.tool == 'remote.bootstrap') {
      final installTmux = call.args['install_tmux'] == true || call.args['install_tmux']?.toString() == 'true';
      final approved = call.args['approved'] == true || call.args['approved']?.toString() == 'true';
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools && (!installTmux || approved),
        risk: installTmux ? 'high' : 'medium',
        reason: installTmux && !approved
            ? 'Remote package installation requires explicit approval.'
            : 'Remote bootstrap creates/checks ~/.ssh_dashboard runtime state.',
      );
    }

    if (call.tool == 'remote.tmux.list' || call.tool == 'remote.tmux.capture') {
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools,
        risk: 'low',
        reason: settings.allowRemoteTools ? 'Read-only persistent tmux inspection.' : 'Remote tools are disabled in settings.',
      );
    }

    if (call.tool == 'remote.tmux.start' || call.tool == 'remote.tmux.send') {
      final command = call.args['command']?.toString() ?? call.args['text']?.toString() ?? '';
      final dangerous = HermesRemoteCommandPolicy.looksDestructive(command);
      final approved = call.args['approved'] == true || call.args['approved']?.toString() == 'true';
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools && (!dangerous || approved),
        risk: dangerous ? 'high' : 'medium',
        reason: dangerous && !approved
            ? 'This tmux action can mutate remote state and needs explicit approval.'
            : 'Persistent tmux mode is allowed for remote agent sessions.',
      );
    }

    if (call.tool == 'remote.tmux.stop' ||
        call.tool == 'ssh.run_approved' ||
        call.tool == 'file.write_text' ||
        call.tool == 'task.launch' ||
        call.tool == 'task.cancel') {
      final approved = call.args['approved'] == true || call.args['approved']?.toString() == 'true';
      return HermesApprovalDecision(
        allowed: settings.allowRemoteTools && approved,
        risk: 'high',
        reason: approved ? 'Explicitly approved high-risk remote operation.' : 'High-risk remote operation requires explicit approval.',
      );
    }

    if (call.tool == 'skill.list' || call.tool == 'skill.read' || call.tool == 'session.search') {
      return const HermesApprovalDecision(allowed: true, risk: 'low', reason: 'Read-only local Hermes state inspection.');
    }

    return const HermesApprovalDecision(
      allowed: false,
      risk: 'unknown',
      reason: 'Tool is not registered in this dashboard-native Hermes edition.',
    );
  }

  bool _isReadOnlyCommand(String command) {
    final clean = command.trim().toLowerCase();
    if (clean.isEmpty) return false;
    final blocked = RegExp(r'\b(rm|mv|cp|chmod|chown|kill|pkill|sudo|python|bash|sh|curl|wget|git|pip|conda|screen|tmux)\b|>|\|\s*(sh|bash)');
    if (blocked.hasMatch(clean)) return false;
    final allowed = RegExp(r'^(nvidia-smi|ps|df|du|tail|head|cat|ls|pwd|whoami|free|uptime|uname|hostname|grep|find)\b');
    return allowed.hasMatch(clean);
  }
}

abstract class HermesEvent {
  const HermesEvent();
}

class HermesUserMessageEvent extends HermesEvent {
  final HermesMessage message;
  const HermesUserMessageEvent(this.message);
}

class HermesAssistantMessageEvent extends HermesEvent {
  final HermesMessage message;
  const HermesAssistantMessageEvent(this.message);
}

class HermesToolCallProposedEvent extends HermesEvent {
  final HermesToolCall call;
  final HermesApprovalDecision decision;
  const HermesToolCallProposedEvent(this.call, this.decision);
}

class HermesToolResultEvent extends HermesEvent {
  final HermesToolResult result;
  const HermesToolResultEvent(this.result);
}

class HermesTurnCompletedEvent extends HermesEvent {
  const HermesTurnCompletedEvent();
}

class HermesErrorEvent extends HermesEvent {
  final String message;
  const HermesErrorEvent(this.message);
}

class HermesToolGateway {
  HermesSessionStore? sessions;
  HermesMemoryStore? memory;

  void attachRuntime({
    HermesSessionStore? sessionStore,
    HermesMemoryStore? memoryStore,
  }) {
    sessions = sessionStore ?? sessions;
    memory = memoryStore ?? memory;
  }

  Future<HermesToolResult> call({
    required String tool,
    required Map<String, dynamic> args,
    required SSHProvider dashboard,
    required HermesSettings settings,
  }) async {
    switch (tool) {
      case 'dashboard.context':
        return _dashboardContext(dashboard, settings);
      case 'gpu.snapshot':
        return _gpuSnapshot(dashboard, settings);
      case 'task.list':
        return _taskList(dashboard);
      case 'file.list':
        return _fileList(dashboard, args);
      case 'file.read_text':
        return _fileReadText(dashboard, args);
      case 'ssh.run_readonly':
        return _sshRunReadonly(dashboard, args);
      case 'ssh.run_approved':
        return _sshRunApproved(dashboard, args);
      case 'remote.bootstrap':
        return _remoteBootstrap(dashboard, args);
      case 'remote.tmux.list':
        return _remoteTmuxList(dashboard);
      case 'remote.tmux.start':
        return _remoteTmuxStart(dashboard, args);
      case 'remote.tmux.send':
        return _remoteTmuxSend(dashboard, args);
      case 'remote.tmux.capture':
        return _remoteTmuxCapture(dashboard, args);
      case 'remote.tmux.stop':
        return _remoteTmuxStop(dashboard, args);
      case 'file.write_text':
        return _fileWriteText(dashboard, args);
      case 'task.launch':
        return _taskLaunch(dashboard, args);
      case 'task.cancel':
        return _taskCancel(dashboard, args);
      case 'skill.list':
        return _skillList(settings);
      case 'skill.read':
        return _skillRead(settings, args);
      case 'skill.write':
        return _skillWrite(settings, args);
      case 'session.search':
        return _sessionSearch(args);
      default:
        return HermesToolResult(
          tool: tool,
          ok: false,
          output: 'Unknown Hermes dashboard tool: $tool',
        );
    }
  }

  HermesToolResult _dashboardContext(SSHProvider dashboard, HermesSettings settings) {
    final data = <String, dynamic>{
      'profile': settings.profile,
      'project': settings.project,
      'connected_host': dashboard.connectedHost,
      'is_connected': dashboard.isConnected,
      'shared_pwd': dashboard.sharedPwd,
      'gpu_count': dashboard.gpus.length,
      'task_count': dashboard.tasks.length,
      'last_updated': dashboard.lastUpdated?.toIso8601String(),
    };
    return HermesToolResult(
      tool: 'dashboard.context',
      ok: true,
      data: data,
      output: const JsonEncoder.withIndent('  ').convert(data),
    );
  }

  HermesToolResult _gpuSnapshot(SSHProvider dashboard, HermesSettings settings) {
    final gpus = dashboard.gpus.map((gpu) {
      return {
        'index': gpu.index,
        'uuid': gpu.uuid,
        'name': gpu.name,
        'utilization_percent': gpu.usage,
        'memory_used_mb': gpu.memoryUsedMb,
        'memory_total_mb': gpu.memoryTotalMb,
        'temperature_c': gpu.temperature,
        'processes': gpu.processes.map((process) {
          return {
            'pid': process.pid,
            'username': process.username,
            'name': process.shortName,
            'used_memory_mb': process.usedMemoryMb,
            'runtime_seconds': process.runtimeSeconds,
            'runtime': process.runtimeLabel,
            'command': process.displayCommand,
          };
        }).toList(),
      };
    }).toList();

    final data = {
      'host': dashboard.connectedHost,
      'project': settings.project,
      'last_updated': dashboard.lastUpdated?.toIso8601String(),
      'gpus': gpus,
    };

    final buffer = StringBuffer();
    buffer.writeln('GPU snapshot for ${dashboard.connectedHost ?? 'no connected host'}');
    if (gpus.isEmpty) {
      buffer.writeln('- No NVIDIA GPU detected or nvidia-smi unavailable.');
    } else {
      for (final gpu in dashboard.gpus) {
        buffer.writeln('- GPU ${gpu.index}: ${gpu.name}, util ${gpu.usage.toStringAsFixed(0)}%, memory ${gpu.memoryUsedMb.toStringAsFixed(0)}/${gpu.memoryTotalMb.toStringAsFixed(0)} MB, temp ${gpu.temperature.toStringAsFixed(0)}C');
        if (gpu.processes.isEmpty) {
          buffer.writeln('  processes: none');
        } else {
          for (final process in gpu.processes) {
            buffer.writeln('  pid ${process.pid}, user ${process.username}, runtime ${process.runtimeLabel}, mem ${process.usedMemoryMb.toStringAsFixed(0)} MB, cmd: ${process.displayCommand}');
          }
        }
      }
    }

    return HermesToolResult(
      tool: 'gpu.snapshot',
      ok: true,
      output: buffer.toString().trimRight(),
      data: data,
    );
  }

  HermesToolResult _taskList(SSHProvider dashboard) {
    final tasks = dashboard.tasks.map((task) => task.toJson()).toList();
    return HermesToolResult(
      tool: 'task.list',
      ok: true,
      data: {'tasks': tasks},
      output: tasks.isEmpty ? 'No dashboard tasks are currently tracked.' : const JsonEncoder.withIndent('  ').convert(tasks),
    );
  }

  Future<HermesToolResult> _fileList(SSHProvider dashboard, Map<String, dynamic> args) async {
    final path = args['path']?.toString().trim().isNotEmpty == true ? args['path'].toString().trim() : dashboard.sharedPwd;
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'file.list', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final listing = await dashboard.listRemoteDirectory(path);
      final data = {
        'path': listing.path,
        'items': listing.items.take(80).map((item) {
          return {
            'name': item.name,
            'path': item.path,
            'type': item.displayType,
            'size_bytes': item.sizeBytes,
            'modified': item.modified,
          };
        }).toList(),
      };
      return HermesToolResult(
        tool: 'file.list',
        ok: true,
        data: data,
        output: const JsonEncoder.withIndent('  ').convert(data),
      );
    } catch (e) {
      return HermesToolResult(tool: 'file.list', ok: false, output: e.toString());
    }
  }

  Future<HermesToolResult> _fileReadText(SSHProvider dashboard, Map<String, dynamic> args) async {
    final path = args['path']?.toString().trim() ?? '';
    final maxBytes = int.tryParse(args['max_bytes']?.toString() ?? '') ?? 120000;
    if (path.isEmpty) {
      return const HermesToolResult(tool: 'file.read_text', ok: false, output: 'Missing required argument: path.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'file.read_text', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final text = await dashboard.readRemoteFile(path, maxBytes: maxBytes.clamp(1024, 262144).toInt());
      return HermesToolResult(tool: 'file.read_text', ok: true, output: text, data: {'path': path});
    } catch (e) {
      return HermesToolResult(tool: 'file.read_text', ok: false, output: e.toString(), data: {'path': path});
    }
  }

  Future<HermesToolResult> _sshRunReadonly(SSHProvider dashboard, Map<String, dynamic> args) async {
    final command = args['command']?.toString().trim() ?? '';
    final client = dashboard.client;
    if (command.isEmpty) {
      return const HermesToolResult(tool: 'ssh.run_readonly', ok: false, output: 'Missing required argument: command.');
    }
    if (client == null || client.isClosed) {
      return const HermesToolResult(tool: 'ssh.run_readonly', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final wrapped = 'bash -lc ${_bashQuote(command)}';
      final raw = await client.run(wrapped).timeout(const Duration(seconds: 12));
      final output = utf8.decode(raw, allowMalformed: true).trim();
      return HermesToolResult(tool: 'ssh.run_readonly', ok: true, output: output.isEmpty ? '[No output]' : output, data: {'command': command});
    } catch (e) {
      return HermesToolResult(tool: 'ssh.run_readonly', ok: false, output: e.toString(), data: {'command': command});
    }
  }

  Future<HermesToolResult> _sshRunApproved(SSHProvider dashboard, Map<String, dynamic> args) async {
    final command = args['command']?.toString().trim() ?? '';
    final timeoutSeconds = int.tryParse(args['timeout_seconds']?.toString() ?? '') ?? 30;
    if (command.isEmpty) {
      return const HermesToolResult(tool: 'ssh.run_approved', ok: false, output: 'Missing required argument: command.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'ssh.run_approved', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final output = await dashboard.runRemoteShell(
        command,
        timeout: Duration(seconds: timeoutSeconds.clamp(3, 180).toInt()),
      );
      return HermesToolResult(
        tool: 'ssh.run_approved',
        ok: true,
        output: output.isEmpty ? '[No output]' : output,
        data: {'command': command},
      );
    } catch (e) {
      return HermesToolResult(tool: 'ssh.run_approved', ok: false, output: e.toString(), data: {'command': command});
    }
  }

  Future<HermesToolResult> _remoteBootstrap(SSHProvider dashboard, Map<String, dynamic> args) async {
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.bootstrap', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final info = await dashboard.bootstrapHermesRemoteRuntime(
        installTmuxIfPossible: args['install_tmux'] == true || args['install_tmux']?.toString() == 'true',
      );
      return HermesToolResult(
        tool: 'remote.bootstrap',
        ok: info.ok,
        output: const JsonEncoder.withIndent('  ').convert(info.toJson()),
        data: info.toJson(),
      );
    } catch (e) {
      return HermesToolResult(tool: 'remote.bootstrap', ok: false, output: e.toString());
    }
  }

  Future<HermesToolResult> _remoteTmuxList(SSHProvider dashboard) async {
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.tmux.list', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final sessions = await dashboard.listHermesTmuxSessions();
      final data = {'sessions': sessions.map((item) => item.toJson()).toList()};
      return HermesToolResult(
        tool: 'remote.tmux.list',
        ok: true,
        output: sessions.isEmpty ? 'No dashboard-managed tmux sessions found.' : const JsonEncoder.withIndent('  ').convert(data),
        data: data,
      );
    } catch (e) {
      return HermesToolResult(tool: 'remote.tmux.list', ok: false, output: e.toString());
    }
  }

  Future<HermesToolResult> _remoteTmuxStart(SSHProvider dashboard, Map<String, dynamic> args) async {
    final name = args['name']?.toString().trim().isNotEmpty == true ? args['name'].toString().trim() : 'hermes';
    final command = args['command']?.toString().trim().isNotEmpty == true ? args['command'].toString().trim() : 'exec bash';
    final cwd = args['cwd']?.toString().trim().isNotEmpty == true ? args['cwd'].toString().trim() : dashboard.sharedPwd;
    final attachIfExists = args['attach_if_exists']?.toString() != 'false';
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.tmux.start', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final session = await dashboard.startHermesTmuxSession(
        name: name,
        command: command,
        cwd: cwd,
        attachIfExists: attachIfExists,
      );
      return HermesToolResult(
        tool: 'remote.tmux.start',
        ok: true,
        output: const JsonEncoder.withIndent('  ').convert(session.toJson()),
        data: session.toJson(),
      );
    } catch (e) {
      return HermesToolResult(tool: 'remote.tmux.start', ok: false, output: e.toString());
    }
  }

  Future<HermesToolResult> _remoteTmuxSend(SSHProvider dashboard, Map<String, dynamic> args) async {
    final name = args['name']?.toString().trim() ?? '';
    final text = args['text']?.toString() ?? '';
    final enter = args['enter']?.toString() != 'false';
    if (name.isEmpty) {
      return const HermesToolResult(tool: 'remote.tmux.send', ok: false, output: 'Missing required argument: name.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.tmux.send', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final output = await dashboard.sendHermesTmuxInput(sessionName: name, text: text, pressEnter: enter);
      return HermesToolResult(tool: 'remote.tmux.send', ok: true, output: output, data: {'name': name, 'entered': enter});
    } catch (e) {
      return HermesToolResult(tool: 'remote.tmux.send', ok: false, output: e.toString(), data: {'name': name});
    }
  }

  Future<HermesToolResult> _remoteTmuxCapture(SSHProvider dashboard, Map<String, dynamic> args) async {
    final name = args['name']?.toString().trim() ?? '';
    final lines = int.tryParse(args['lines']?.toString() ?? '') ?? 160;
    if (name.isEmpty) {
      return const HermesToolResult(tool: 'remote.tmux.capture', ok: false, output: 'Missing required argument: name.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.tmux.capture', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final output = await dashboard.captureHermesTmuxSession(sessionName: name, lines: lines);
      return HermesToolResult(tool: 'remote.tmux.capture', ok: !output.startsWith('__ERROR__'), output: output, data: {'name': name});
    } catch (e) {
      return HermesToolResult(tool: 'remote.tmux.capture', ok: false, output: e.toString(), data: {'name': name});
    }
  }

  Future<HermesToolResult> _remoteTmuxStop(SSHProvider dashboard, Map<String, dynamic> args) async {
    final name = args['name']?.toString().trim() ?? '';
    if (name.isEmpty) {
      return const HermesToolResult(tool: 'remote.tmux.stop', ok: false, output: 'Missing required argument: name.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'remote.tmux.stop', ok: false, output: 'SSH target is not connected.');
    }
    try {
      final output = await dashboard.stopHermesTmuxSession(name);
      return HermesToolResult(tool: 'remote.tmux.stop', ok: true, output: output, data: {'name': name});
    } catch (e) {
      return HermesToolResult(tool: 'remote.tmux.stop', ok: false, output: e.toString(), data: {'name': name});
    }
  }

  Future<HermesToolResult> _fileWriteText(SSHProvider dashboard, Map<String, dynamic> args) async {
    final path = args['path']?.toString().trim() ?? '';
    final content = args['content']?.toString() ?? '';
    if (path.isEmpty) {
      return const HermesToolResult(tool: 'file.write_text', ok: false, output: 'Missing required argument: path.');
    }
    if (!dashboard.isConnected) {
      return const HermesToolResult(tool: 'file.write_text', ok: false, output: 'SSH target is not connected.');
    }
    try {
      await dashboard.writeRemoteFile(path, content, maxBytes: 1024 * 1024);
      return HermesToolResult(tool: 'file.write_text', ok: true, output: 'Wrote ${content.length} chars to $path.', data: {'path': path});
    } catch (e) {
      return HermesToolResult(tool: 'file.write_text', ok: false, output: e.toString(), data: {'path': path});
    }
  }

  Future<HermesToolResult> _taskLaunch(SSHProvider dashboard, Map<String, dynamic> args) async {
    final id = args['task_id']?.toString().trim() ?? '';
    final matches = dashboard.tasks.where((task) => task.id == id || task.title == id).toList();
    if (matches.isEmpty) return HermesToolResult(tool: 'task.launch', ok: false, output: 'Task not found: $id');
    try {
      await dashboard.launchTask(matches.first);
      return HermesToolResult(tool: 'task.launch', ok: true, output: 'Task launched: ${matches.first.title}', data: matches.first.toJson());
    } catch (e) {
      return HermesToolResult(tool: 'task.launch', ok: false, output: e.toString(), data: matches.first.toJson());
    }
  }

  Future<HermesToolResult> _taskCancel(SSHProvider dashboard, Map<String, dynamic> args) async {
    final id = args['task_id']?.toString().trim() ?? '';
    final matches = dashboard.tasks.where((task) => task.id == id || task.title == id).toList();
    if (matches.isEmpty) return HermesToolResult(tool: 'task.cancel', ok: false, output: 'Task not found: $id');
    try {
      await dashboard.cancelTask(matches.first);
      return HermesToolResult(tool: 'task.cancel', ok: true, output: 'Task cancelled: ${matches.first.title}', data: matches.first.toJson());
    } catch (e) {
      return HermesToolResult(tool: 'task.cancel', ok: false, output: e.toString(), data: matches.first.toJson());
    }
  }

  Future<HermesToolResult> _skillList(HermesSettings settings) async {
    if (kIsWeb) return const HermesToolResult(tool: 'skill.list', ok: false, output: 'Skills are unavailable on web.');
    final dir = io.Directory('${_expandedHermesHome(settings.hermesHome)}/skills');
    try {
      if (!await dir.exists()) await dir.create(recursive: true);
      final files = await dir
          .list()
          .where((entity) => entity is io.File && entity.path.toLowerCase().endsWith('.md'))
          .cast<io.File>()
          .toList();
      files.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
      final data = {
        'skills': files.map((file) => {'name': file.uri.pathSegments.last, 'path': file.path}).toList(),
      };
      return HermesToolResult(
        tool: 'skill.list',
        ok: true,
        output: files.isEmpty ? 'No markdown skills found in ${dir.path}.' : const JsonEncoder.withIndent('  ').convert(data),
        data: data,
      );
    } catch (e) {
      return HermesToolResult(tool: 'skill.list', ok: false, output: e.toString());
    }
  }

  Future<HermesToolResult> _skillRead(HermesSettings settings, Map<String, dynamic> args) async {
    if (kIsWeb) return const HermesToolResult(tool: 'skill.read', ok: false, output: 'Skills are unavailable on web.');
    var name = args['name']?.toString().trim() ?? '';
    if (name.isEmpty) return const HermesToolResult(tool: 'skill.read', ok: false, output: 'Missing required argument: name.');
    name = name.replaceAll('\\', '/').split('/').last;
    if (!name.toLowerCase().endsWith('.md')) name = '$name.md';
    final file = io.File('${_expandedHermesHome(settings.hermesHome)}/skills/$name');
    try {
      if (!await file.exists()) return HermesToolResult(tool: 'skill.read', ok: false, output: 'Skill not found: $name');
      final text = await file.readAsString();
      return HermesToolResult(tool: 'skill.read', ok: true, output: text, data: {'name': name, 'path': file.path});
    } catch (e) {
      return HermesToolResult(tool: 'skill.read', ok: false, output: e.toString(), data: {'name': name});
    }
  }

  Future<HermesToolResult> _skillWrite(HermesSettings settings, Map<String, dynamic> args) async {
    if (kIsWeb) return const HermesToolResult(tool: 'skill.write', ok: false, output: 'Skills are unavailable on web.');
    var name = args['name']?.toString().trim() ?? '';
    final content = args['content']?.toString() ?? '';
    if (name.isEmpty) return const HermesToolResult(tool: 'skill.write', ok: false, output: 'Missing required argument: name.');
    if (content.isEmpty) return const HermesToolResult(tool: 'skill.write', ok: false, output: 'Missing required argument: content.');
    name = name.replaceAll('\\', '/').split('/').last;
    if (!name.toLowerCase().endsWith('.md')) name = '$name.md';
    final file = io.File('${_expandedHermesHome(settings.hermesHome)}/skills/$name');
    try {
      await file.parent.create(recursive: true);
      await file.writeAsString(content, flush: true);
      return HermesToolResult(
        tool: 'skill.write',
        ok: true,
        output: 'Skill successfully written/updated: $name (${content.length} chars).',
        data: {'name': name, 'path': file.path},
      );
    } catch (e) {
      return HermesToolResult(tool: 'skill.write', ok: false, output: e.toString(), data: {'name': name});
    }
  }

  Future<HermesToolResult> _sessionSearch(Map<String, dynamic> args) async {
    final store = sessions;
    if (store == null) return const HermesToolResult(tool: 'session.search', ok: false, output: 'Session store is not attached to tool gateway.');
    final query = args['query']?.toString().trim().toLowerCase() ?? '';
    final limit = (int.tryParse(args['limit']?.toString() ?? '') ?? 8).clamp(1, 20).toInt();
    if (query.isEmpty) return const HermesToolResult(tool: 'session.search', ok: false, output: 'Missing required argument: query.');
    try {
      final results = store.searchLoadedMessages(query, limit: limit);
      return HermesToolResult(
        tool: 'session.search',
        ok: true,
        output: results.isEmpty ? 'No loaded-session matches.' : const JsonEncoder.withIndent('  ').convert({'matches': results}),
        data: {'matches': results},
      );
    } catch (e) {
      return HermesToolResult(tool: 'session.search', ok: false, output: e.toString());
    }
  }

  String _expandedHermesHome(String raw) {
    var path = raw.trim();
    if (path.isEmpty) {
      if (!kIsWeb && io.Platform.isWindows) return '${io.Platform.environment['APPDATA'] ?? '.'}\\cozypad_hermes';
      return '${!kIsWeb ? io.Platform.environment['HOME'] ?? '.' : '.'}/.cozypad_hermes';
    }
    if (path.startsWith('%APPDATA%') && !kIsWeb && io.Platform.isWindows) {
      final appData = io.Platform.environment['APPDATA'];
      if (appData != null && appData.isNotEmpty) path = path.replaceFirst('%APPDATA%', appData);
    }
    if ((path == '~' || path.startsWith('~/')) && !kIsWeb) {
      final home = io.Platform.environment['HOME'];
      if (home != null && home.isNotEmpty) path = path == '~' ? home : '$home/${path.substring(2)}';
    }
    return path;
  }

  String _bashQuote(String input) {
    return "'${input.replaceAll("'", "'\"'\"'")}'";
  }
}

