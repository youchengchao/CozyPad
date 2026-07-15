part of cozypad;

/// Route A: dashboard-native Hermes harness.
///
/// This is not a persona prompt wrapper. It owns the turn orchestration:
/// runtime-frame assembly, session persistence, memory preflight, tool registry,
/// approval policy, tool dispatch, observation folding, and model continuation.
/// Google AI Studio remains only the model provider.
class HermesHarnessConfig {
  final int maxModelTurns;
  final int maxToolCalls;
  final int maxObservationChars;
  final bool forceContextPreflight;

  const HermesHarnessConfig({
    this.maxModelTurns = 6,
    this.maxToolCalls = 6,
    this.maxObservationChars = 9000,
    this.forceContextPreflight = true,
  });
}

class HermesRuntimeContext {
  final String profile;
  final String project;
  final String? connectedHost;
  final bool isConnected;
  final String sharedPwd;
  final int gpuCount;
  final int taskCount;
  final DateTime? telemetryUpdatedAt;
  final DateTime createdAt;

  HermesRuntimeContext({
    required this.profile,
    required this.project,
    required this.connectedHost,
    required this.isConnected,
    required this.sharedPwd,
    required this.gpuCount,
    required this.taskCount,
    required this.telemetryUpdatedAt,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  factory HermesRuntimeContext.fromInput(HermesTurnInput input) {
    final dashboard = input.dashboard;
    final settings = input.settings;
    return HermesRuntimeContext(
      profile: settings.profile.trim().isEmpty ? 'default' : settings.profile.trim(),
      project: settings.project.trim().isEmpty ? 'general' : settings.project.trim(),
      connectedHost: dashboard.connectedHost,
      isConnected: dashboard.isConnected,
      sharedPwd: dashboard.sharedPwd,
      gpuCount: dashboard.gpus.length,
      taskCount: dashboard.tasks.length,
      telemetryUpdatedAt: dashboard.lastUpdated,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'profile': profile,
      'project': project,
      'connected_host': connectedHost,
      'is_connected': isConnected,
      'shared_pwd': sharedPwd,
      'gpu_count': gpuCount,
      'task_count': taskCount,
      'telemetry_updated_at': telemetryUpdatedAt?.toIso8601String(),
      'runtime_frame_created_at': createdAt.toIso8601String(),
    };
  }

  String formatForPrompt() {
    return const JsonEncoder.withIndent('  ').convert(toJson());
  }
}

class HermesToolDefinition {
  final String name;
  final String description;
  final String risk;
  final bool remote;
  final bool mutating;
  final Map<String, dynamic> argsSchema;

  const HermesToolDefinition({
    required this.name,
    required this.description,
    required this.risk,
    this.remote = false,
    this.mutating = false,
    this.argsSchema = const {},
  });

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'description': description,
      'risk': risk,
      'remote': remote,
      'mutating': mutating,
      'args_schema': argsSchema,
    };
  }
}

class HermesToolRegistry {
  final Map<String, HermesToolDefinition> definitions;

  HermesToolRegistry(Iterable<HermesToolDefinition> tools)
      : definitions = {for (final tool in tools) tool.name: tool};

  factory HermesToolRegistry.dashboardDefault() {
    return HermesToolRegistry([
      const HermesToolDefinition(
        name: 'memory',
        description: 'Hermes built-in bounded memory store. Persists durable project/user facts to MEMORY.md or USER.md.',
        risk: 'low',
        argsSchema: {
          'action': 'add | replace | remove',
          'target': 'memory | user',
          'content': 'New memory text for add/replace.',
          'old_text': 'Existing text or substring for replace/remove.',
        },
      ),
      const HermesToolDefinition(
        name: 'dashboard.context',
        description: 'Read current dashboard runtime context: profile, project, SSH host, working directory, GPU/task counts.',
        risk: 'low',
        argsSchema: {},
      ),
      const HermesToolDefinition(
        name: 'gpu.snapshot',
        description: 'Read current GPU telemetry and GPU process metadata from the dashboard provider.',
        risk: 'low',
        argsSchema: {},
      ),
      const HermesToolDefinition(
        name: 'task.list',
        description: 'Read the dashboard task list for the active workspace.',
        risk: 'low',
        argsSchema: {},
      ),
      const HermesToolDefinition(
        name: 'file.list',
        description: 'List a remote directory through the active SSH target.',
        risk: 'low',
        remote: true,
        argsSchema: {'path': 'Remote directory path. Defaults to current dashboard pwd.'},
      ),
      const HermesToolDefinition(
        name: 'file.read_text',
        description: 'Read a remote text file preview through the active SSH target.',
        risk: 'low',
        remote: true,
        argsSchema: {'path': 'Remote file path.', 'max_bytes': 'Optional byte limit, clamped by the dashboard.'},
      ),
      const HermesToolDefinition(
        name: 'ssh.run_readonly',
        description: 'Run a narrowly classified read-only SSH command. Mutating commands are blocked by approval policy.',
        risk: 'medium',
        remote: true,
        argsSchema: {'command': 'Read-only shell command such as ls, df, du, ps, tail, head, free, uptime, nvidia-smi.'},
      ),
      const HermesToolDefinition(
        name: 'ssh.run_approved',
        description: 'Run an approval-gated remote shell command through SSH. Used for install, launch, kill, write, and other mutating operations after policy approval.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'command': 'Shell command.', 'approved': 'Must be true for mutating commands.', 'timeout_seconds': 'Optional timeout.'},
      ),
      const HermesToolDefinition(
        name: 'remote.bootstrap',
        description: 'Install/check the lightweight ~/.ssh_dashboard remote runtime and detect tmux/python/git. Optionally attempts non-interactive tmux install.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'install_tmux': 'Optional bool. If true, try sudo -n package install for tmux.'},
      ),
      const HermesToolDefinition(
        name: 'remote.tmux.list',
        description: 'List persistent tmux sessions created by this dashboard. These sessions survive local app disconnects.',
        risk: 'low',
        remote: true,
        argsSchema: {},
      ),
      const HermesToolDefinition(
        name: 'remote.tmux.start',
        description: 'Start or attach to a persistent remote tmux session. This is the replacement for messaging gateways in this product.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'name': 'Session name.', 'command': 'Command to start inside tmux.', 'cwd': 'Working directory.', 'attach_if_exists': 'Default true.'},
      ),
      const HermesToolDefinition(
        name: 'remote.tmux.send',
        description: 'Send input to a persistent remote tmux session.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'name': 'Session name.', 'text': 'Input text.', 'enter': 'Whether to press Enter. Default true.'},
      ),
      const HermesToolDefinition(
        name: 'remote.tmux.capture',
        description: 'Capture the screen buffer from a persistent remote tmux session.',
        risk: 'low',
        remote: true,
        argsSchema: {'name': 'Session name.', 'lines': 'Number of lines to capture.'},
      ),
      const HermesToolDefinition(
        name: 'remote.tmux.stop',
        description: 'Stop a dashboard-managed persistent remote tmux session.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'name': 'Session name.', 'approved': 'Must be true.'},
      ),
      const HermesToolDefinition(
        name: 'file.write_text',
        description: 'Approval-gated remote text file write through SSH.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'path': 'Remote file path.', 'content': 'Text content.', 'approved': 'Must be true.'},
      ),
      const HermesToolDefinition(
        name: 'task.launch',
        description: 'Launch an existing dashboard task on the remote host using the dashboard task executor.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'task_id': 'Dashboard task id.', 'approved': 'Must be true.'},
      ),
      const HermesToolDefinition(
        name: 'task.cancel',
        description: 'Cancel an existing dashboard task and terminate its process if running.',
        risk: 'high',
        remote: true,
        mutating: true,
        argsSchema: {'task_id': 'Dashboard task id.', 'approved': 'Must be true.'},
      ),
      const HermesToolDefinition(
        name: 'skill.list',
        description: 'List local markdown skills from hermes_home/skills.',
        risk: 'low',
        argsSchema: {},
      ),
      const HermesToolDefinition(
        name: 'skill.read',
        description: 'Read a local markdown skill from hermes_home/skills.',
        risk: 'low',
        argsSchema: {'name': 'Skill file name without path traversal.'},
      ),
      const HermesToolDefinition(
        name: 'skill.write',
        description: 'Create or update a local markdown skill. Enables the learning loop.',
        risk: 'medium',
        argsSchema: {'name': 'Skill file name (e.g. check_run.md).', 'content': 'Full Markdown skill content.'},
      ),
      const HermesToolDefinition(
        name: 'session.search',
        description: 'Search persisted local Hermes session JSON for text.',
        risk: 'low',
        argsSchema: {'query': 'Search query.', 'limit': 'Max results.'},
      ),
    ]);
  }

  bool contains(String name) => definitions.containsKey(name.trim());

  String describeForPrompt() {
    final encoded = definitions.values.map((tool) => tool.toJson()).toList();
    return const JsonEncoder.withIndent('  ').convert(encoded);
  }
}

class HermesProtocolCodec {
  HermesToolCall? parseToolRequest(String reply) {
    final decoded = decodeProtocolObject(reply);
    if (decoded == null) return null;
    if (decoded['type']?.toString() != 'tool_request') return null;
    final tool = decoded['tool']?.toString().trim() ?? '';
    if (tool.isEmpty) return null;
    final args = decoded['args'] is Map ? Map<String, dynamic>.from(decoded['args'] as Map) : <String, dynamic>{};
    return HermesToolCall(
      tool: tool,
      args: args,
      reason: decoded['reason']?.toString().trim().isNotEmpty == true
          ? decoded['reason'].toString().trim()
          : 'Model requested a dashboard tool.',
    );
  }

  HermesMessage assistantMessageFromReply(String reply) {
    final decoded = decodeProtocolObject(reply);
    final sideChannel = extractModelSideChannel(reply);
    if (decoded != null) {
      final type = decoded['type']?.toString();
      if (type == 'normal_answer') {
        final answer = decoded['answer']?.toString().trim().isNotEmpty == true
            ? decoded['answer'].toString().trim()
            : 'I received your message.';
        final parts = <HermesMessagePart>[HermesMessagePart.text(answer)];
        if (sideChannel.trim().isNotEmpty) {
          parts.add(HermesMessagePart.trace(sideChannel.trim(), kind: 'model_visible_notes'));
        }
        return HermesMessage(role: 'assistant', parts: parts);
      }
      if (type == 'clarification_request') {
        final optionsRaw = decoded['options'];
        final options = optionsRaw is List
            ? optionsRaw.map((item) => item.toString()).where((item) => item.trim().isNotEmpty).take(6).toList()
            : const <String>[];
        final parts = <HermesMessagePart>[
          HermesMessagePart.clarification(
            question: decoded['question']?.toString().trim().isNotEmpty == true
                ? decoded['question'].toString().trim()
                : 'I need one clarification before continuing.',
            options: options,
            reason: decoded['reason']?.toString() ?? '',
          ),
        ];
        if (sideChannel.trim().isNotEmpty) {
          parts.add(HermesMessagePart.trace(sideChannel.trim(), kind: 'model_visible_notes'));
        }
        return HermesMessage(role: 'assistant', parts: parts);
      }
    }

    final fallback = fallbackVisibleAnswer(reply);
    final parts = <HermesMessagePart>[HermesMessagePart.text(fallback)];
    final sideChannelFallback = extractLikelyReasoningPreamble(reply, fallback);
    if (sideChannelFallback.trim().isNotEmpty) {
      parts.add(HermesMessagePart.trace(sideChannelFallback.trim(), kind: 'model_visible_notes'));
    }
    return HermesMessage(role: 'assistant', parts: parts);
  }

  Map<String, dynamic>? decodeProtocolObject(String reply) {
    final candidates = <String>[];
    final clean = stripCodeFence(reply.trim());
    if (clean.isNotEmpty) candidates.add(clean);

    final fenced = RegExp(r'```(?:json)?\s*([\s\S]*?)```', caseSensitive: false).allMatches(reply);
    for (final match in fenced) {
      final group = match.group(1)?.trim();
      if (group != null && group.isNotEmpty) candidates.add(group);
    }

    final extracted = extractLastJsonObject(reply);
    if (extracted != null) candidates.add(extracted);

    final seen = <String>{};
    for (final candidate in candidates.reversed) {
      final trimmed = candidate.trim();
      if (trimmed.isEmpty || !seen.add(trimmed)) continue;
      try {
        final decoded = jsonDecode(trimmed);
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      } catch (_) {
        final repaired = repairProtocolObject(trimmed);
        if (repaired != null) return repaired;
      }
    }
    return repairProtocolObject(reply);
  }

  Map<String, dynamic>? repairProtocolObject(String raw) {
    final clean = stripCodeFence(raw.trim());
    if (clean.isEmpty || !clean.contains('normal_answer') && !clean.contains('clarification_request')) {
      return null;
    }

    final typeMatch = RegExp(r'''["']type["']\s*:\s*["']([^"']+)["']''', caseSensitive: false).firstMatch(clean);
    final type = typeMatch?.group(1)?.trim();
    if (type == null || type.isEmpty) return null;

    if (type == 'normal_answer') {
      final answer = looseExtractJsonStringField(clean, 'answer') ?? extractMalformedNormalAnswer(clean);
      if (answer != null && answer.trim().isNotEmpty) {
        return <String, dynamic>{
          'type': 'normal_answer',
          'answer': decodeLooseJsonString(answer).trim(),
        };
      }
    }

    if (type == 'clarification_request') {
      final question = looseExtractJsonStringField(clean, 'question');
      if (question != null && question.trim().isNotEmpty) {
        return <String, dynamic>{
          'type': 'clarification_request',
          'question': decodeLooseJsonString(question).trim(),
          'options': looseExtractJsonStringArrayField(clean, 'options'),
        };
      }
    }
    return null;
  }

  String? looseExtractJsonStringField(String text, String field) {
    final pattern = RegExp(
      '"${RegExp.escape(field)}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"[A-Za-z0-9_]+"\\s*:|}\\s*\$)',
      caseSensitive: false,
    );
    final match = pattern.firstMatch(text);
    if (match != null) return match.group(1);

    final startPattern = RegExp('"${RegExp.escape(field)}"\\s*:\\s*"', caseSensitive: false);
    final startMatch = startPattern.firstMatch(text);
    if (startMatch == null) return null;
    final start = startMatch.end;
    var end = text.lastIndexOf('"');
    if (end <= start) end = text.length;
    return text.substring(start, end).replaceFirst(RegExp(r'}\s*$'), '').trim();
  }

  List<String> looseExtractJsonStringArrayField(String text, String field) {
    final pattern = RegExp('"${RegExp.escape(field)}"\\s*:\\s*\\[([\\s\\S]*?)\\]', caseSensitive: false);
    final match = pattern.firstMatch(text);
    if (match == null) return const <String>[];
    final rawItems = match.group(1) ?? '';
    final itemMatches = RegExp(r'"([\s\S]*?)"').allMatches(rawItems);
    return itemMatches
        .map((match) => decodeLooseJsonString(match.group(1) ?? '').trim())
        .where((item) => item.isNotEmpty)
        .take(6)
        .toList();
  }

  String? extractMalformedNormalAnswer(String text) {
    final malformed = RegExp(
      r'^\s*\{\s*"type"\s*:\s*"normal_answer"\s*:\s*"([\s\S]*)"\s*\}\s*$',
      caseSensitive: false,
    ).firstMatch(text);
    if (malformed != null) return malformed.group(1);

    final typeMatch = RegExp(r'"normal_answer"\s*:\s*"([\s\S]*)"\s*\}\s*$', caseSensitive: false).firstMatch(text);
    if (typeMatch != null) return typeMatch.group(1);
    return null;
  }

  String decodeLooseJsonString(String value) {
    return value
        .replaceAll(r'\n', '\n')
        .replaceAll(r'\r', '\r')
        .replaceAll(r'\t', '\t')
        .replaceAll(r'\"', '"')
        .replaceAll(r'\\', '\\');
  }

  String? extractLastJsonObject(String text) {
    final starts = <int>[];
    final ends = <int>[];
    for (var i = 0; i < text.length; i++) {
      final ch = text[i];
      if (ch == '{') starts.add(i);
      if (ch == '}') ends.add(i);
    }
    for (final start in starts.reversed) {
      for (final end in ends.reversed) {
        if (end <= start) continue;
        final candidate = text.substring(start, end + 1).trim();
        if (!candidate.contains('"type"')) continue;
        try {
          final decoded = jsonDecode(candidate);
          if (decoded is Map) return candidate;
        } catch (_) {
          if (repairProtocolObject(candidate) != null) return candidate;
        }
      }
    }
    return null;
  }

  String extractModelSideChannel(String reply) {
    final clean = reply.trim();
    if (clean.isEmpty) return '';
    final jsonObject = extractLastJsonObject(clean);
    if (jsonObject == null) return '';
    final before = clean.substring(0, clean.indexOf(jsonObject)).trim();
    final afterIndex = clean.indexOf(jsonObject) + jsonObject.length;
    final after = afterIndex < clean.length ? clean.substring(afterIndex).trim() : '';
    return sanitizeModelSideChannel([before, after].where((item) => item.isNotEmpty).join('\n\n'));
  }

  String extractLikelyReasoningPreamble(String reply, String visibleAnswer) {
    final clean = reply.trim();
    if (clean.isEmpty || clean == visibleAnswer.trim()) return '';
    if (clean.startsWith('{')) return '';
    final marker = RegExp(r'(^|\n)\s*(Plan:|Analysis:|Reasoning:)', caseSensitive: false).firstMatch(clean);
    if (marker == null && !RegExp(r'^\s*The user said', caseSensitive: false).hasMatch(clean)) return '';
    final answerIndex = clean.indexOf(visibleAnswer.trim());
    final preamble = answerIndex > 0 ? clean.substring(0, answerIndex).trim() : clean;
    return sanitizeModelSideChannel(preamble);
  }

  String sanitizeModelSideChannel(String text) {
    var clean = text.trim();
    if (clean.isEmpty) return '';
    clean = clean.replaceAll(RegExp(r'```(?:json)?\s*', caseSensitive: false), '').replaceAll('```', '').trim();
    if (clean.length > 2400) {
      clean = '${clean.substring(0, 2400).trimRight()}\n…';
    }
    return clean;
  }

  String fallbackVisibleAnswer(String reply) {
    final decoded = decodeProtocolObject(reply);
    if (decoded != null && decoded['answer'] != null) return decoded['answer'].toString().trim();
    var clean = reply.trim();
    final jsonObject = extractLastJsonObject(clean);
    if (jsonObject != null) clean = clean.replaceAll(jsonObject, '').trim();
    if (clean.startsWith('{') && clean.contains('normal_answer')) {
      return 'I received your message, but the model returned a malformed protocol response. Please try again.';
    }
    if (RegExp(r'^\s*(the user said|plan:|analysis:)', caseSensitive: false).hasMatch(clean)) {
      return 'I received your message.';
    }
    return clean.isEmpty ? 'I received your message.' : clean;
  }

  String stripCodeFence(String text) {
    var clean = text.trim();
    if (clean.startsWith('```')) {
      clean = clean.replaceFirst(RegExp(r'^```(?:json)?\s*'), '');
      clean = clean.replaceFirst(RegExp(r'\s*```$'), '');
    }
    return clean.trim();
  }
}

class HermesHarness {
  final HermesLlmClient llm;
  final HermesSessionStore sessions;
  final HermesMemoryStore memory;
  final HermesToolGateway tools;
  final HermesApprovalPolicy policy;
  final HermesPromptBuilder promptBuilder;
  final HermesToolRegistry registry;
  final HermesProtocolCodec codec;
  final HermesHarnessConfig config;
  final List<String> _availableSkills = [];

  HermesHarness({
    required this.llm,
    required this.sessions,
    required this.memory,
    required this.tools,
    required this.policy,
    required this.promptBuilder,
    HermesToolRegistry? registry,
    HermesProtocolCodec? codec,
    this.config = const HermesHarnessConfig(),
  })  : registry = registry ?? HermesToolRegistry.dashboardDefault(),
      codec = codec ?? HermesProtocolCodec();

  Future<void> _loadAvailableSkills(HermesSettings settings) async {
    _availableSkills.clear();
    if (kIsWeb) return;
    try {
      final home = tools._expandedHermesHome(settings.hermesHome);
      final dir = io.Directory('$home/skills');
      if (await dir.exists()) {
        final files = await dir
            .list()
            .where((entity) => entity is io.File && entity.path.toLowerCase().endsWith('.md'))
            .cast<io.File>()
            .toList();
        for (final file in files) {
          _availableSkills.add(file.uri.pathSegments.last);
        }
        _availableSkills.sort();
      }
    } catch (_) {}
  }

  Stream<HermesEvent> runTurn(HermesTurnInput input) async* {
    await _loadAndSyncSession(input);
    await _loadAvailableSkills(input.settings);
    final session = sessions.activeSession!;
    final runtime = HermesRuntimeContext.fromInput(input);


    final userMessage = HermesMessage(
      role: 'user',
      parts: [HermesMessagePart.text(input.text.trim())],
    );
    session.messages.add(userMessage);
    if (session.title.startsWith('Session (')) {
      final firstLine = input.text.trim().split('\n').first.trim();
      final newTitle = firstLine.length > 25 ? '${firstLine.substring(0, 25)}...' : firstLine;
      if (newTitle.isNotEmpty) {
        session.title = newTitle;
      }
    }
    await sessions.save();
    yield HermesUserMessageEvent(userMessage);

    final observations = <String>[];
    final toolKeys = <String, int>{};

    try {
      for (final call in _preflightToolCalls(input)) {
        final observation = await _executeTool(call, input, session);
        for (final event in observation.events) {
          yield event;
        }
        observations.add(_compactObservation(observation.result));
      }

      for (var step = 0; step < config.maxModelTurns; step++) {
        final systemPrompt = _buildSystemPrompt(input.settings);
        final userPrompt = _buildHarnessPrompt(
          input: input,
          session: session,
          runtime: runtime,
          observations: observations,
        );

        final liveHistoryMessages = session.messages.length <= 40
            ? List<HermesMessage>.from(session.messages)
            : List<HermesMessage>.from(session.messages.sublist(session.messages.length - 40));

        final reply = await llm.generate(
          apiKey: input.settings.apiKey,
          baseUrl: input.settings.baseUrl,
          model: input.settings.model,
          systemPrompt: systemPrompt,
          userPrompt: userPrompt,
          historyMessages: liveHistoryMessages,
        );

        final requestedCall = codec.parseToolRequest(reply);
        if (requestedCall == null) {
          final assistant = codec.assistantMessageFromReply(reply);
          session.messages.add(assistant);
          await sessions.save();
          yield HermesAssistantMessageEvent(assistant);
          yield const HermesTurnCompletedEvent();
          return;
        }

        final key = _toolKey(requestedCall);
        toolKeys[key] = (toolKeys[key] ?? 0) + 1;
        if (toolKeys[key]! > 2) {
          final assistant = HermesMessage(
            role: 'assistant',
            parts: [
              HermesMessagePart.clarification(
                question: 'Hermes requested the same tool repeatedly. Should I summarize the current observations or continue with another safe step?',
                options: const ['Summarize current observations', 'Continue with another safe tool step'],
              ),
            ],
          );
          session.messages.add(assistant);
          await sessions.save();
          yield HermesAssistantMessageEvent(assistant);
          yield const HermesTurnCompletedEvent();
          return;
        }

        if (toolKeys.values.fold<int>(0, (sum, value) => sum + value) > config.maxToolCalls) {
          final assistant = HermesMessage(
            role: 'assistant',
            parts: [
              HermesMessagePart.clarification(
                question: 'Hermes reached the tool-call budget for this turn. What should I do next?',
                options: const ['Summarize tool observations', 'Start a new turn'],
              ),
            ],
          );
          session.messages.add(assistant);
          await sessions.save();
          yield HermesAssistantMessageEvent(assistant);
          yield const HermesTurnCompletedEvent();
          return;
        }

        final observation = await _executeTool(requestedCall, input, session);
        for (final event in observation.events) {
          yield event;
        }
        if (observation.result.output == 'Pending user approval...') {
          yield const HermesTurnCompletedEvent();
          return;
        }
        observations.add(_compactObservation(observation.result));
      }

      final assistant = HermesMessage(
        role: 'assistant',
        parts: [
          HermesMessagePart.clarification(
            question: 'I completed the harness loop budget. Should I summarize the current observations or continue in a new turn?',
            options: const ['Summarize current observations', 'Continue in a new turn'],
          ),
        ],
      );
      session.messages.add(assistant);
      await sessions.save();
      yield HermesAssistantMessageEvent(assistant);
      yield const HermesTurnCompletedEvent();
    } catch (e) {
      final message = HermesMessage(role: 'system', parts: [HermesMessagePart.error(e.toString())]);
      session.messages.add(message);
      await sessions.save();
      yield HermesErrorEvent(e.toString());
    }
  }

  Future<void> _loadAndSyncSession(HermesTurnInput input) async {
    await sessions.load(
      profile: input.settings.profile,
      project: input.settings.project,
      connectedHost: input.dashboard.connectedHost,
      sessionId: sessions.activeSession?.id,
    );
    final session = sessions.activeSession!;
    session.profile = input.settings.profile.trim().isEmpty ? 'default' : input.settings.profile.trim();
    session.project = input.settings.project.trim().isEmpty ? 'general' : input.settings.project.trim();
    session.connectedHost = input.dashboard.connectedHost;
    memory.profile = session.profile;
    memory.project = session.project;

    if (session.frozenMemoryPrompt == null || session.frozenMemoryPrompt!.trim().isEmpty) {
      final snapshot = await memory.loadSnapshot();
      session.frozenMemoryPrompt = snapshot.formatForPrompt();
      await sessions.save();
    }
  }

  String _buildSystemPrompt(HermesSettings settings) {
    final base = promptBuilder.buildSystemPrompt(
      settings,
      frozenMemoryPrompt: sessions.activeSession?.frozenMemoryPrompt ?? '',
    );
    final buffer = StringBuffer();
    buffer.writeln(base.trimRight());
    buffer.writeln();
    buffer.writeln('Harness boundary:');
    buffer.writeln('- You are running inside a Dart-native Hermes harness, not a role-play prompt.');
    buffer.writeln('- The harness, not the model, owns sessions, tool dispatch, memory writes, approval policy, and observation folding.');
    buffer.writeln('- Only request tools from the registered schema below. Do not invent tool names.');
    buffer.writeln('- After each observation, either request one additional useful tool or produce normal_answer JSON.');
    buffer.writeln();
    buffer.writeln('Registered Hermes tool schema:');
    buffer.writeln(registry.describeForPrompt());
    return buffer.toString().trimRight();
  }

  String _buildHarnessPrompt({
    required HermesTurnInput input,
    required HermesSession session,
    required HermesRuntimeContext runtime,
    required List<String> observations,
  }) {
    final observation = observations.where((item) => item.trim().isNotEmpty).join('\n\n---\n\n');
    final base = promptBuilder.buildUserPrompt(
      input: input,
      session: session,
      observation: observation.trim().isEmpty ? null : observation,
    );

    final buffer = StringBuffer();
    buffer.writeln('Hermes harness runtime frame:');
    buffer.writeln(runtime.formatForPrompt());
    buffer.writeln();
    buffer.writeln('Available Learned Skills (use skill.read to load a skill recipe if it applies to your current task):');
    if (_availableSkills.isEmpty) {
      buffer.writeln('- No learned skills available. Use skill.write to learn a new skill when a complex task is completed.');
    } else {
      for (final skill in _availableSkills) {
        buffer.writeln('- $skill');
      }
    }
    buffer.writeln();
    buffer.writeln('Harness loop rules:');
    buffer.writeln('- If live dashboard state is needed, request a registered tool.');
    buffer.writeln('- If enough observations are present, produce normal_answer JSON.');
    buffer.writeln('- Do not describe tools you did not actually observe.');
    buffer.writeln('- Do not output markdown outside the JSON answer field.');
    buffer.writeln();
    buffer.write(base);
    return buffer.toString().trimRight();
  }

  List<HermesToolCall> _preflightToolCalls(HermesTurnInput input) {
    final calls = <HermesToolCall>[];
    final text = input.text.trim();
    final lower = text.toLowerCase();

    final memoryCall = _explicitMemoryToolCall(text);
    if (memoryCall != null) calls.add(memoryCall);

    if (config.forceContextPreflight && _shouldReadDashboardContext(lower)) {
      calls.add(const HermesToolCall(
        tool: 'dashboard.context',
        args: {},
        reason: 'The user is asking about the active dashboard/runtime context.',
      ));
    }

    if (_shouldForceGpuSnapshot(lower)) {
      calls.add(const HermesToolCall(
        tool: 'gpu.snapshot',
        args: {},
        reason: 'The user is asking about current GPU/resource status, so the dashboard must read live telemetry before answering.',
      ));
    }

    if (_shouldReadTasks(lower)) {
      calls.add(const HermesToolCall(
        tool: 'task.list',
        args: {},
        reason: 'The user is asking about tracked tasks or agent work queue.',
      ));
    }

    if (_shouldReadRemoteRuntime(lower)) {
      calls.add(const HermesToolCall(
        tool: 'remote.bootstrap',
        args: {'install_tmux': false},
        reason: 'The user is asking about remote persistent runtime or tmux mode; check the remote dashboard runtime before answering.',
      ));
      calls.add(const HermesToolCall(
        tool: 'remote.tmux.list',
        args: {},
        reason: 'The user is asking about persistent remote sessions; list dashboard-managed tmux sessions.',
      ));
    }

    final deduped = <String, HermesToolCall>{};
    for (final call in calls) {
      deduped['${call.tool}:${jsonEncode(call.args)}'] = call;
    }
    return deduped.values.toList(growable: false);
  }

  Future<_HermesHarnessObservation> _executeTool(
    HermesToolCall call,
    HermesTurnInput input,
    HermesSession session,
  ) async {
    final events = <HermesEvent>[];

    if (!registry.contains(call.tool)) {
      final result = HermesToolResult(
        tool: call.tool,
        ok: false,
        output: 'Tool is not registered in the dashboard-native Hermes harness: ${call.tool}',
      );
      session.messages.add(HermesMessage(role: 'tool', parts: [
        HermesMessagePart.toolCall(tool: call.tool, args: call.args, reason: call.reason),
        HermesMessagePart.toolResult(tool: result.tool, ok: false, output: result.output),
      ]));
      await sessions.save();
      events.add(HermesToolResultEvent(result));
      return _HermesHarnessObservation(result: result, events: events);
    }

    final decision = policy.evaluate(call, input.settings);
    events.add(HermesToolCallProposedEvent(call, decision));
    session.messages.add(
      HermesMessage(
        role: 'tool',
        parts: [HermesMessagePart.toolCall(tool: call.tool, args: call.args, reason: call.reason)],
      ),
    );

    if (!decision.allowed) {
      if (input.settings.allowRemoteTools && (decision.risk == 'high' || decision.risk == 'medium')) {
        final cmdStr = call.tool == 'ssh.run_approved'
            ? '`ssh run: ${call.args['command']}`'
            : '`${call.tool}` with args: ${jsonEncode(call.args)}';

        final approvalQuestion = HermesMessage(
          role: 'assistant',
          parts: [
            HermesMessagePart.clarification(
              question: 'Hermes requested a high-risk operation: $cmdStr. Do you approve and execute?',
              options: const ['Approve and execute', 'Reject operation'],
              reason: decision.reason,
            ),
          ],
        );

        session.messages.add(approvalQuestion);

        final pendingResult = HermesToolResult(
          tool: call.tool,
          ok: false,
          output: 'Pending user approval...',
        );
        session.messages.add(
          HermesMessage(
            role: 'tool',
            parts: [HermesMessagePart.toolResult(tool: pendingResult.tool, ok: false, output: pendingResult.output)],
          ),
        );

        await sessions.save();
        events.add(HermesAssistantMessageEvent(approvalQuestion));
        events.add(HermesToolResultEvent(pendingResult));

        return _HermesHarnessObservation(result: pendingResult, events: events);
      }

      final blocked = HermesToolResult(
        tool: call.tool,
        ok: false,
        output: 'Tool blocked by Hermes approval policy. Risk: ${decision.risk}. Reason: ${decision.reason}',
      );
      session.messages.add(
        HermesMessage(
          role: 'tool',
          parts: [HermesMessagePart.toolResult(tool: blocked.tool, ok: false, output: blocked.output)],
        ),
      );
      await sessions.save();
      events.add(HermesToolResultEvent(blocked));
      return _HermesHarnessObservation(result: blocked, events: events);
    }

    final HermesToolResult result;
    if (call.tool == 'memory') {
      final memoryResult = await memory.applyTool(call.args);
      result = HermesToolResult(
        tool: 'memory',
        ok: memoryResult.success,
        output: memoryResult.output,
        data: {
          'mutated': memoryResult.mutated,
          'memory_usage': '${memoryResult.snapshot.memory.usedChars}/${memoryResult.snapshot.memory.limit}',
          'user_usage': '${memoryResult.snapshot.user.usedChars}/${memoryResult.snapshot.user.limit}',
        },
      );
    } else {
      result = await tools.call(
        tool: call.tool,
        args: call.args,
        dashboard: input.dashboard,
        settings: input.settings,
      );
    }

    session.messages.add(
      HermesMessage(
        role: 'tool',
        parts: [HermesMessagePart.toolResult(tool: result.tool, ok: result.ok, output: result.output)],
      ),
    );
    await sessions.save();
    events.add(HermesToolResultEvent(result));
    return _HermesHarnessObservation(result: result, events: events);
  }

  String _compactObservation(HermesToolResult result) {
    final dataText = result.data.isEmpty ? '' : '\nStructured data:\n${const JsonEncoder.withIndent('  ').convert(result.data)}';
    var text = 'Tool observation: ${result.tool} (${result.ok ? 'ok' : 'failed'})\n${result.output}$dataText'.trimRight();
    if (text.length > config.maxObservationChars) {
      text = '${text.substring(0, config.maxObservationChars).trimRight()}\n...[observation truncated by harness]';
    }
    return text;
  }

  String _toolKey(HermesToolCall call) => '${call.tool}:${jsonEncode(call.args)}';

  HermesToolCall? _explicitMemoryToolCall(String text) {
    final clean = text.trim();
    final lower = clean.toLowerCase();
    final patterns = [
      RegExp(r'^(remember that|remember|note that|keep in memory|memorize)[:,\s]+(.+)$', caseSensitive: false, dotAll: true),
      RegExp(r'^(請記住|記住|幫我記住|備註)[:：,\s]*(.+)$', dotAll: true),
    ];
    for (final pattern in patterns) {
      final match = pattern.firstMatch(clean);
      final content = match?.group(match.groupCount)?.trim();
      if (content != null && content.isNotEmpty) {
        final target = _looksLikeUserPreference(content) ? 'user' : 'memory';
        return HermesToolCall(
          tool: 'memory',
          args: {
            'action': 'add',
            'target': target,
            'content': content,
          },
          reason: 'The user explicitly asked Hermes to remember this durable information.',
        );
      }
    }
    if (lower.startsWith('forget ') || clean.startsWith('忘記')) {
      final oldText = clean.replaceFirst(RegExp(r'^(forget|忘記)[:：,\s]*', caseSensitive: false), '').trim();
      if (oldText.isNotEmpty) {
        return HermesToolCall(
          tool: 'memory',
          args: {
            'action': 'remove',
            'target': 'memory',
            'old_text': oldText,
          },
          reason: 'The user explicitly asked Hermes to forget a memory entry.',
        );
      }
    }
    return null;
  }

  bool _looksLikeUserPreference(String content) {
    final lower = content.toLowerCase();
    return lower.contains('i prefer') ||
        lower.contains('my preference') ||
        lower.contains('call me') ||
        lower.contains('我喜歡') ||
        lower.contains('我偏好') ||
        lower.contains('我的偏好') ||
        lower.contains('以後請') ||
        lower.contains('之後請');
  }

  bool _shouldReadRemoteRuntime(String lower) {
    return lower.contains('tmux') ||
        lower.contains('persistent') ||
        lower.contains('remote runtime') ||
        lower.contains('remote control') ||
        lower.contains('不中斷') ||
        lower.contains('持續運行') ||
        lower.contains('遠端持續') ||
        lower.contains('遠端安裝') ||
        lower.contains('工作階段') ||
        lower.contains('session 不會死') ||
        lower.contains('vscode');
  }

  bool _shouldReadDashboardContext(String lower) {
    return lower.contains('dashboard') ||
        lower.contains('context') ||
        lower.contains('host') ||
        lower.contains('pwd') ||
        lower.contains('工作目錄') ||
        lower.contains('目前連線') ||
        lower.contains('連線狀態') ||
        lower.contains('現在在哪') ||
        lower.contains('目前狀態');
  }

  bool _shouldForceGpuSnapshot(String lower) {
    return lower.contains('gpu') ||
        lower.contains('顯卡') ||
        lower.contains('nvidia') ||
        lower.contains('目前資源') ||
        lower.contains('資源狀態') ||
        lower.contains('現在狀態') ||
        lower.contains('跑滿') ||
        lower.contains('idle') ||
        lower.contains('vram');
  }

  bool _shouldReadTasks(String lower) {
    return lower.contains('task') ||
        lower.contains('todo') ||
        lower.contains('queue') ||
        lower.contains('任務') ||
        lower.contains('工作佇列') ||
        lower.contains('待辦');
  }
}

class _HermesHarnessObservation {
  final HermesToolResult result;
  final List<HermesEvent> events;

  const _HermesHarnessObservation({
    required this.result,
    required this.events,
  });
}
