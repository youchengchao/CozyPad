part of cozypad;

class HermesPromptBuilder {
  String buildSystemPrompt(HermesSettings settings, {String frozenMemoryPrompt = ''}) {
    final buffer = StringBuffer();
    buffer.writeln(settings.soul.trim().isEmpty
        ? 'You are Hermes inside SSH Dashboard: an AI agent for deep-learning operations, multi-machine context, task management, and hardware-aware automation.'
        : settings.soul.trim());
    buffer.writeln();
    buffer.writeln('Product positioning:');
    buffer.writeln('- You are an AI agent first, not merely a GPU chatbot or a passive dashboard helper.');
    buffer.writeln('- Position SSH Dashboard Hermes as a focused agent distribution/control plane: multi-PC context, task management, SSH/file context, and live hardware telemetry are built into the agent environment.');
    buffer.writeln('- When compared with native/general Hermes Agent, do not frame this product as a weaker non-agent. Frame it as the same class of agentic system with a narrower deployment target and stronger dashboard-native context.');
    buffer.writeln('- Deliberately omitted capabilities include consumer messaging gateways such as Discord/Telegram/Slack. The replacement control plane is first-party desktop/mobile app access to persistent remote sessions.');
    buffer.writeln('- Added product advantages include centralized multi-machine context, visible GPU/CPU/storage state, persisted task/session state, remote file/log inspection, and safer approval-gated ops.');
    buffer.writeln();
    buffer.writeln('Runtime contract:');
    buffer.writeln('- You run as a dashboard-native Dart/Flutter agent layer.');
    buffer.writeln('- The local Windows app owns the Hermes harness. Remote servers may receive lightweight ~/.ssh_dashboard runtime files and tmux sessions through SSH, similar to VS Code remote behavior.');
    buffer.writeln('- Do not claim consumer messaging gateways are required; this product replaces those entry points with the dashboard app.');
    buffer.writeln('- Google AI Studio is only the model backend; the dashboard engine owns sessions, tools, approvals, memory, tasks, and persistence.');
    buffer.writeln('- You must not claim to have inspected current GPU/file/task state unless a tool observation is present.');
    buffer.writeln('- Destructive operations, process kills, file writes, and multi-GPU launches require explicit approval.');
    buffer.writeln();
    if (frozenMemoryPrompt.trim().isNotEmpty) {
      buffer.writeln(frozenMemoryPrompt.trimRight());
      buffer.writeln();
      buffer.writeln('Memory note: this memory block is a frozen snapshot captured at session start. Live memory writes are persisted immediately but only appear here after a new session snapshot.');
      buffer.writeln();
    }
    buffer.writeln('Available tools:');
    buffer.writeln('- memory: Hermes built-in memory tool. Args: action add|replace|remove, target memory|user|general, content, old_text. Use target=memory for project-specific memory (conventions, lessons, status). Use target=general for general memory (global notes across all projects). Use target=user for user profile/preferences.');
    buffer.writeln('- dashboard.context: read profile/project/host/task metadata and the dashboard-native agent environment.');
    buffer.writeln('- gpu.snapshot: read current GPU utilization, memory, temperature, and GPU processes.');
    buffer.writeln('- task.list: read tracked dashboard tasks across the active workspace context.');
    buffer.writeln('- file.list: list a remote directory through the connected SSH target.');
    buffer.writeln('- file.read_text: read a remote text file preview.');
    buffer.writeln('- ssh.run_readonly: run a narrowly read-only SSH command.');
    buffer.writeln('- remote.bootstrap: install/check ~/.ssh_dashboard remote runtime and tmux availability.');
    buffer.writeln('- remote.tmux.list/start/send/capture/stop: manage persistent remote sessions that survive app disconnects.');
    buffer.writeln('- ssh.run_approved, file.write_text, task.launch, task.cancel: approval-gated remote mutations.');
    buffer.writeln('- skill.list, skill.read, skill.write: manage learned markdown skills to support self-evolution.');
    buffer.writeln('- session.search: search persisted local Hermes session JSON for text.');
    buffer.writeln();
    buffer.writeln('Self-Evolution (Skill Learning Loop) copied from Hermes Agent:');
    buffer.writeln('- Reflect on the steps and recipes used after completing a complex or novel task.');
    buffer.writeln('- If the process contains reusable procedural knowledge, generalize it into a "Skill" and write it as a Markdown file in the skills directory using the `skill.write` tool (e.g. name: "train_yolov8.md", content: "# YOLOv8 Training Recipe...").');
    buffer.writeln('- Check the list of available learned skills provided in the harness runtime frame. If a learned skill matches your current task, proactively use `skill.read` to load its recipe before attempting the task.');
    buffer.writeln();
    buffer.writeln('Interactive Tool Approval Flow:');
    buffer.writeln('- When you request a high-risk tool (e.g. ssh.run_approved, file.write_text) without pre-approval, the harness will pause and ask the user for approval.');
    buffer.writeln('- When the user replies to the approval prompt with "Approve" or "Approve and execute", you must re-request the exact same tool with the exact same arguments but add `"approved": true` to the args dictionary (e.g. `"args": {"command": "...", "approved": true}`).');
    buffer.writeln('- If the user rejects the operation, do not run the tool; find an alternative or report the cancellation.');
    buffer.writeln();
    buffer.writeln('Memory behavior copied from Hermes Agent:');
    buffer.writeln('- Save compact useful long-term facts proactively when learned: user preferences, environment facts, project conventions, corrections, completed work, and lessons learned.');
    buffer.writeln('- Skip trivial, obvious, raw dump, or session-only facts.');
    buffer.writeln('- When memory is near capacity, consolidate by replace/remove before add.');
    buffer.writeln();
    buffer.writeln('Response protocol:');
    buffer.writeln('- Output exactly one JSON object and nothing else. Do not write Plan, Analysis, reasoning, markdown, or explanatory text before or after JSON.');
    buffer.writeln('- Do not generate a compressed thinking summary, trace, or hidden-reasoning substitute. The UI may hide any accidental pre-JSON prose in a collapsed notes panel, but you should not create that text.');
    buffer.writeln('- If you need a tool, respond with strict JSON only. Keep reason to one short operational sentence:');
    buffer.writeln('{"type":"tool_request","tool":"gpu.snapshot","args":{},"reason":"Need current GPU status from dashboard telemetry."}');
    buffer.writeln('- For memory writes, respond with strict JSON only:');
    buffer.writeln('{"type":"tool_request","tool":"memory","args":{"action":"add","target":"memory","content":"Project uses ..."},"reason":"Persist durable project memory."}');
    buffer.writeln('- If the user request is ambiguous and you should ask a Claude Code style follow-up question, respond with strict JSON only and do not include a reason field:');
    buffer.writeln('{"type":"clarification_request","question":"Which log file should I inspect?","options":["Use the latest train.log","I will paste the path"]}');
    buffer.writeln('- If no tool or follow-up question is needed, respond with strict JSON only:');
    buffer.writeln('{"type":"normal_answer","answer":"..."}');
    buffer.writeln('- If asked for product positioning, comparison, or self-evaluation, answer as an AI agent/control-plane product: emphasize focused scope, deliberate omissions, and added multi-PC/task/hardware context.');
    buffer.writeln('Never expose hidden chain-of-thought. Never include Plan or Analysis in the visible answer.');
    return buffer.toString().trimRight();
  }

  String buildUserPrompt({
    required HermesTurnInput input,
    required HermesSession session,
    String? observation,
    bool includeHistory = false,
  }) {
    final buffer = StringBuffer();
    buffer.writeln('Active profile: ${input.settings.profile}');
    buffer.writeln('Active project: ${input.settings.project}');
    buffer.writeln('Connected SSH host: ${input.dashboard.connectedHost ?? 'none'}');
    buffer.writeln('Remote tools allowed: ${input.settings.allowRemoteTools}');
    buffer.writeln();
    if (includeHistory) {
      final recent = session.messages.length <= 10
          ? session.messages
          : session.messages.sublist(session.messages.length - 10);
      if (recent.isNotEmpty) {
        buffer.writeln('Recent session messages:');
        for (final message in recent) {
          if (message.role == 'tool') continue;
          final text = _messageTextForPrompt(message).trim();
          if (text.isEmpty) continue;
          buffer.writeln('${message.role}: $text');
        }
        buffer.writeln();
      }
    }
    if (observation != null && observation.trim().isNotEmpty) {
      buffer.writeln('Tool observation:');
      buffer.writeln(observation.trimRight());
      buffer.writeln();
      buffer.writeln('Now answer the user using the observation. Be explicit that the observation came from the dashboard tool when it matters. Use normal_answer JSON unless you need a tool or a clarification question. Do not add trace or reasoning summaries.');
      buffer.writeln();
    }
    buffer.writeln('User message:');
    buffer.writeln(input.text.trim());
    return buffer.toString().trimRight();
  }

  String _messageTextForPrompt(HermesMessage message) {
    final visibleParts = message.parts.where((part) {
      return part.type == 'text' || part.type == 'error' || part.type == 'clarification';
    }).map((part) => part.text.trim()).where((text) => text.isNotEmpty).toList();
    if (visibleParts.isEmpty) return '';
    final joined = visibleParts.join('\n');
    const maxChars = 1800;
    if (joined.length <= maxChars) return joined;
    return joined.substring(joined.length - maxChars);
  }
}

class HermesLlmClient {
  Future<String> generate({
    required String apiKey,
    required String baseUrl,
    required String model,
    required String systemPrompt,
    required String userPrompt,
    List<HermesMessage>? historyMessages,
  }) async {
    final cleanBase = baseUrl.trim().isEmpty 
        ? 'https://generativelanguage.googleapis.com/v1beta' 
        : baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    final cleanModel = model.trim().isEmpty ? 'gemma-4-26b-a4b-it' : model.trim();
    final cleanApiKey = apiKey.trim();

    final isGemini = cleanBase.contains('generativelanguage.googleapis.com');
    final uri = isGemini
        ? Uri.parse('$cleanBase/models/$cleanModel:generateContent').replace(
            queryParameters: cleanApiKey.isNotEmpty ? {'key': cleanApiKey} : null,
          )
        : Uri.parse('$cleanBase/chat/completions');

    final List<Map<String, dynamic>> userParts = [];
    final List<Map<String, dynamic>> imageParts = [];
    String cleanUserPrompt = userPrompt;

    final imgMatches = RegExp(r'!\[.*?\]\((file:///.*?)\)').allMatches(userPrompt);
    for (final match in imgMatches) {
      final fileUrl = match.group(1);
      if (fileUrl != null) {
        try {
          final filePath = Uri.parse(fileUrl).toFilePath();
          final file = io.File(filePath);
          if (await file.exists()) {
            final bytes = await file.readAsBytes();
            final base64Data = base64Encode(bytes);
            imageParts.add({
              'inlineData': {
                'mimeType': 'image/png',
                'data': base64Data,
              }
            });
            cleanUserPrompt = cleanUserPrompt.replaceAll(match.group(0)!, '');
          }
        } catch (_) {}
      }
    }

    userParts.add({'text': cleanUserPrompt.trim()});
    userParts.addAll(imageParts);

    final List<Map<String, dynamic>> openAiMessages = [
      {'role': 'system', 'content': systemPrompt},
    ];

    if (historyMessages != null && historyMessages.isNotEmpty) {
      String? lastRole;
      for (final msg in historyMessages) {
        final role = msg.role == 'model' || msg.role == 'assistant' ? 'assistant' : 'user';
        final content = _formatMessageForLlm(msg);
        if (content.isEmpty) continue;

        if (lastRole == role) {
          final lastMsg = openAiMessages.last;
          if (lastMsg['content'] is String) {
            lastMsg['content'] = '${lastMsg['content']}\n\n$content';
          } else if (lastMsg['content'] is List) {
            final contentList = lastMsg['content'] as List;
            contentList.add({'type': 'text', 'text': content});
          }
        } else {
          openAiMessages.add({'role': role, 'content': content});
          lastRole = role;
        }
      }
    }

    if (openAiMessages.isNotEmpty && openAiMessages.last['role'] == 'user') {
      final lastMsg = openAiMessages.last;
      if (imageParts.isNotEmpty) {
        List<Map<String, dynamic>> contentList;
        if (lastMsg['content'] is String) {
          contentList = [
            {'type': 'text', 'text': lastMsg['content'] as String},
          ];
          lastMsg['content'] = contentList;
        } else {
          contentList = List<Map<String, dynamic>>.from(lastMsg['content'] as List);
          lastMsg['content'] = contentList;
        }
        contentList.add({'type': 'text', 'text': cleanUserPrompt.trim()});
        for (final imgPart in imageParts) {
          final mimeType = imgPart['inlineData']['mimeType'];
          final data = imgPart['inlineData']['data'];
          contentList.add({
            'type': 'image_url',
            'image_url': {
              'url': 'data:$mimeType;base64,$data'
            }
          });
        }
      } else {
        if (lastMsg['content'] is String) {
          lastMsg['content'] = '${lastMsg['content']}\n\n${cleanUserPrompt.trim()}';
        } else if (lastMsg['content'] is List) {
          final contentList = lastMsg['content'] as List;
          contentList.add({'type': 'text', 'text': cleanUserPrompt.trim()});
        }
      }
    } else {
      if (imageParts.isNotEmpty) {
        final List<Map<String, dynamic>> openAiContent = [
          {'type': 'text', 'text': cleanUserPrompt.trim()},
        ];
        for (final imgPart in imageParts) {
          final mimeType = imgPart['inlineData']['mimeType'];
          final data = imgPart['inlineData']['data'];
          openAiContent.add({
            'type': 'image_url',
            'image_url': {
              'url': 'data:$mimeType;base64,$data'
            }
          });
        }
        openAiMessages.add({'role': 'user', 'content': openAiContent});
      } else {
        openAiMessages.add({'role': 'user', 'content': cleanUserPrompt.trim()});
      }
    }

    final List<Map<String, dynamic>> geminiContents = [];
    if (historyMessages != null && historyMessages.isNotEmpty) {
      String? currentRole;
      final List<Map<String, dynamic>> currentParts = [];
      
      for (final msg in historyMessages) {
        final role = msg.role == 'model' || msg.role == 'assistant' ? 'model' : 'user';
        final content = _formatMessageForLlm(msg);
        if (content.isEmpty) continue;
        
        if (currentRole == null) {
          currentRole = role;
          currentParts.add({'text': content});
        } else if (currentRole == role) {
          currentParts.add({'text': '\n\n$content'});
        } else {
          geminiContents.add({
            'role': currentRole,
            'parts': List<Map<String, dynamic>>.from(currentParts),
          });
          currentRole = role;
          currentParts.clear();
          currentParts.add({'text': content});
        }
      }
      
      if (currentRole != null) {
        geminiContents.add({
          'role': currentRole,
          'parts': currentParts,
        });
      }
    }

    if (geminiContents.isNotEmpty && geminiContents.last['role'] == 'user') {
      final lastParts = geminiContents.last['parts'] as List<Map<String, dynamic>>;
      lastParts.add({'text': '\n\n${cleanUserPrompt.trim()}'});
      lastParts.addAll(imageParts);
    } else {
      geminiContents.add({
        'role': 'user',
        'parts': [
          {'text': cleanUserPrompt.trim()},
          ...imageParts,
        ],
      });
    }

    final Map<String, dynamic> payload;
    if (isGemini) {
      payload = {
        'systemInstruction': {
          'parts': [
            {'text': systemPrompt},
          ],
        },
        'contents': geminiContents,
        'generationConfig': {
          'temperature': 0.25,
        },
      };
    } else {
      payload = {
        'model': cleanModel,
        'messages': openAiMessages,
        'temperature': 0.25,
      };
    }

    final client = io.HttpClient();
    try {
      final request = await client.postUrl(uri).timeout(const Duration(seconds: 30));
      request.headers.contentType = io.ContentType.json;
      if (cleanApiKey.isNotEmpty && !isGemini) {
        request.headers.set('Authorization', 'Bearer $cleanApiKey');
      }
      request.write(jsonEncode(payload));
      final response = await request.close().timeout(const Duration(seconds: 180));
      final body = await response.transform(utf8.decoder).join();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception('LLM HTTP ${response.statusCode}: $body');
      }
      final decoded = jsonDecode(body);
      
      final String text;
      if (isGemini) {
        text = _extractGeminiText(decoded).trim();
      } else {
        text = _extractOpenAiText(decoded).trim();
      }

      if (text.isEmpty) {
        throw Exception('LLM returned an empty response.');
      }
      return text;
    } finally {
      client.close(force: true);
    }
  }

  String _formatMessageForLlm(HermesMessage message) {
    final buffer = StringBuffer();
    for (final part in message.parts) {
      if (part.type == 'text' || part.type == 'error' || part.type == 'clarification') {
        buffer.writeln(part.text);
      } else if (part.type == 'tool_call') {
        final tool = part.metadata['tool'] ?? '';
        final args = part.metadata['args'] ?? {};
        buffer.writeln('Thought: ${part.text}');
        buffer.writeln('Proposed Tool Call: $tool with args: ${jsonEncode(args)}');
      } else if (part.type == 'tool_result') {
        final tool = part.metadata['tool'] ?? '';
        final ok = part.metadata['ok'] ?? false;
        buffer.writeln('Observation from tool "$tool" (Success: $ok):');
        buffer.writeln(part.text);
      } else if (part.type == 'trace') {
        buffer.writeln(part.text);
      }
    }
    return buffer.toString().trim();
  }

  String _extractGeminiText(dynamic decoded) {
    if (decoded is! Map) return '';
    final candidates = decoded['candidates'];
    if (candidates is! List || candidates.isEmpty) return '';
    final first = candidates.first;
    if (first is! Map) return '';
    final content = first['content'];
    if (content is! Map) return '';
    final parts = content['parts'];
    if (parts is! List) return '';
    final buffer = StringBuffer();
    for (final part in parts) {
      if (part is Map && part['text'] != null) {
        buffer.write(part['text'].toString());
      }
    }
    return buffer.toString();
  }

  String _extractOpenAiText(dynamic decoded) {
    if (decoded is! Map) return '';
    final choices = decoded['choices'];
    if (choices is! List || choices.isEmpty) return '';
    final first = choices.first;
    if (first is! Map) return '';
    final message = first['message'];
    if (message is! Map) return '';
    return message['content']?.toString() ?? '';
  }
}

class HermesAgentEngine {
  final HermesLlmClient llm;
  final HermesSessionStore sessions;
  final HermesMemoryStore memory;
  final HermesToolGateway tools;
  final HermesApprovalPolicy policy;
  final HermesPromptBuilder promptBuilder;

  HermesAgentEngine({
    required this.llm,
    required this.sessions,
    required this.memory,
    required this.tools,
    required this.policy,
    required this.promptBuilder,
  });

  Stream<HermesEvent> runTurn(HermesTurnInput input) {
    tools.attachRuntime(sessionStore: sessions, memoryStore: memory);
    return HermesHarness(
      llm: llm,
      sessions: sessions,
      memory: memory,
      tools: tools,
      policy: policy,
      promptBuilder: promptBuilder,
      registry: HermesToolRegistry.dashboardDefault(),
    ).runTurn(input);
  }

  Future<_HermesToolObservation> _runTool(
    HermesToolCall call,
    HermesTurnInput input,
    HermesSession session,
  ) async {
    final decision = policy.evaluate(call, input.settings);
    final events = <HermesEvent>[HermesToolCallProposedEvent(call, decision)];
    session.messages.add(
      HermesMessage(
        role: 'tool',
        parts: [HermesMessagePart.toolCall(tool: call.tool, args: call.args, reason: call.reason)],
      ),
    );

    if (!decision.allowed) {
      final blocked = HermesToolResult(
        tool: call.tool,
        ok: false,
        output: 'Tool blocked by approval policy. Risk: ${decision.risk}. Reason: ${decision.reason}',
      );
      session.messages.add(
        HermesMessage(
          role: 'tool',
          parts: [HermesMessagePart.toolResult(tool: blocked.tool, ok: false, output: blocked.output)],
        ),
      );
      await sessions.save();
      events.add(HermesToolResultEvent(blocked));
      return _HermesToolObservation(result: blocked, events: events);
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
          'general_usage': '${memoryResult.snapshot.general.usedChars}/${memoryResult.snapshot.general.limit}',
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
    return _HermesToolObservation(result: result, events: events);
  }

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

  bool _shouldForceGpuSnapshot(String text) {
    final lower = text.toLowerCase();
    return lower.contains('gpu') ||
        lower.contains('顯卡') ||
        lower.contains('nvidia') ||
        lower.contains('目前資源') ||
        lower.contains('資源狀態') ||
        lower.contains('現在狀態') ||
        lower.contains('跑滿') ||
        lower.contains('idle');
  }

  HermesToolCall? _parseToolRequest(String reply) {
    final decoded = _decodeProtocolObject(reply);
    if (decoded == null) return null;
    if (decoded['type']?.toString() != 'tool_request') return null;
    final tool = decoded['tool']?.toString() ?? '';
    if (tool.isEmpty) return null;
    final args = decoded['args'] is Map ? Map<String, dynamic>.from(decoded['args'] as Map) : <String, dynamic>{};
    return HermesToolCall(
      tool: tool,
      args: args,
      reason: decoded['reason']?.toString() ?? 'Model requested a dashboard tool.',
    );
  }

  HermesMessage _assistantMessageFromReply(String reply) {
    final decoded = _decodeProtocolObject(reply);
    final sideChannel = _extractModelSideChannel(reply);
    if (decoded != null) {
      final type = decoded['type']?.toString();
      if (type == 'normal_answer') {
        final answer = decoded['answer']?.toString().trim().isNotEmpty == true
            ? decoded['answer'].toString().trim()
            : _fallbackVisibleAnswer(reply);
        final parts = <HermesMessagePart>[HermesMessagePart.text(answer)];
        if (sideChannel.trim().isNotEmpty) {
          parts.add(HermesMessagePart.trace(sideChannel.trim(), kind: 'model_visible_notes'));
        }
        return HermesMessage(role: 'assistant', parts: parts);
      }
      if (type == 'clarification_request') {
        final question = decoded['question']?.toString().trim().isNotEmpty == true
            ? decoded['question'].toString().trim()
            : 'I need one more detail before I can continue.';
        final optionsRaw = decoded['options'];
        final options = optionsRaw is List
            ? optionsRaw.map((item) => item.toString()).where((item) => item.trim().isNotEmpty).take(6).toList()
            : <String>[];
        final parts = <HermesMessagePart>[
          HermesMessagePart.clarification(question: question, options: options),
        ];
        if (sideChannel.trim().isNotEmpty) {
          parts.add(HermesMessagePart.trace(sideChannel.trim(), kind: 'model_visible_notes'));
        }
        return HermesMessage(role: 'assistant', parts: parts);
      }
    }
    final fallback = _fallbackVisibleAnswer(reply);
    final parts = <HermesMessagePart>[HermesMessagePart.text(fallback)];
    final sideChannelFallback = _extractLikelyReasoningPreamble(reply, fallback);
    if (sideChannelFallback.trim().isNotEmpty) {
      parts.add(HermesMessagePart.trace(sideChannelFallback.trim(), kind: 'model_visible_notes'));
    }
    return HermesMessage(role: 'assistant', parts: parts);
  }

  Map<String, dynamic>? _decodeProtocolObject(String reply) {
    final candidates = <String>[];
    final clean = _stripCodeFence(reply.trim());
    if (clean.isNotEmpty) candidates.add(clean);

    final fenced = RegExp(r'```(?:json)?\s*([\s\S]*?)```', caseSensitive: false).allMatches(reply);
    for (final match in fenced) {
      final group = match.group(1)?.trim();
      if (group != null && group.isNotEmpty) candidates.add(group);
    }

    final extracted = _extractLastJsonObject(reply);
    if (extracted != null) candidates.add(extracted);

    final seen = <String>{};
    for (final candidate in candidates.reversed) {
      final trimmed = candidate.trim();
      if (trimmed.isEmpty || !seen.add(trimmed)) continue;
      try {
        final decoded = jsonDecode(trimmed);
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      } catch (_) {
        final repaired = _repairProtocolObject(trimmed);
        if (repaired != null) return repaired;
      }
    }

    // Last resort: repair directly from the full model response. This catches
    // malformed outputs such as {"type":"normal_answer":"..."} that otherwise
    // used to leak the raw protocol into the chat bubble.
    return _repairProtocolObject(reply);
  }

  Map<String, dynamic>? _repairProtocolObject(String raw) {
    final clean = _stripCodeFence(raw.trim());
    if (clean.isEmpty || !clean.contains('normal_answer') && !clean.contains('clarification_request')) {
      return null;
    }

    final typeMatch = RegExp(r'''["']type["']\s*:\s*["']([^"']+)["']''', caseSensitive: false).firstMatch(clean);
    final type = typeMatch?.group(1)?.trim();
    if (type == null || type.isEmpty) return null;

    if (type == 'normal_answer') {
      final answer = _looseExtractJsonStringField(clean, 'answer') ?? _extractMalformedNormalAnswer(clean);
      if (answer != null && answer.trim().isNotEmpty) {
        return <String, dynamic>{
          'type': 'normal_answer',
          'answer': _decodeLooseJsonString(answer).trim(),
        };
      }
    }

    if (type == 'clarification_request') {
      final question = _looseExtractJsonStringField(clean, 'question');
      if (question != null && question.trim().isNotEmpty) {
        return <String, dynamic>{
          'type': 'clarification_request',
          'question': _decodeLooseJsonString(question).trim(),
          'options': _looseExtractJsonStringArrayField(clean, 'options'),
        };
      }
    }

    return null;
  }

  String? _looseExtractJsonStringField(String text, String field) {
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

  List<String> _looseExtractJsonStringArrayField(String text, String field) {
    final pattern = RegExp('"${RegExp.escape(field)}"\\s*:\\s*\\[([\\s\\S]*?)\\]', caseSensitive: false);
    final match = pattern.firstMatch(text);
    if (match == null) return const <String>[];
    final rawItems = match.group(1) ?? '';
    final itemMatches = RegExp(r'"([\s\S]*?)"').allMatches(rawItems);
    return itemMatches
        .map((match) => _decodeLooseJsonString(match.group(1) ?? '').trim())
        .where((item) => item.isNotEmpty)
        .take(6)
        .toList();
  }

  String? _extractMalformedNormalAnswer(String text) {
    final malformed = RegExp(
      r'^\s*\{\s*"type"\s*:\s*"normal_answer"\s*:\s*"([\s\S]*)"\s*\}\s*$',
      caseSensitive: false,
    ).firstMatch(text);
    if (malformed != null) return malformed.group(1);

    final typeMatch = RegExp(r'"normal_answer"\s*:\s*"([\s\S]*)"\s*\}\s*$', caseSensitive: false).firstMatch(text);
    if (typeMatch != null) return typeMatch.group(1);

    return null;
  }

  String _decodeLooseJsonString(String value) {
    // Manual unescape is intentionally conservative: it handles the common
    // escapes produced by Gemini without trying to reinterpret arbitrary text.
    return value
        .replaceAll(r'\n', '\n')
        .replaceAll(r'\r', '\r')
        .replaceAll(r'\t', '\t')
        .replaceAll(r'\"', '"')
        .replaceAll(r'\\', '\\');
  }

  String? _extractLastJsonObject(String text) {
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
          if (_repairProtocolObject(candidate) != null) return candidate;
        }
      }
    }
    return null;
  }

  String _extractModelSideChannel(String reply) {
    final clean = reply.trim();
    if (clean.isEmpty) return '';
    final jsonObject = _extractLastJsonObject(clean);
    if (jsonObject == null) return '';
    final before = clean.substring(0, clean.indexOf(jsonObject)).trim();
    final afterIndex = clean.indexOf(jsonObject) + jsonObject.length;
    final after = afterIndex < clean.length ? clean.substring(afterIndex).trim() : '';
    return _sanitizeModelSideChannel([before, after].where((item) => item.isNotEmpty).join('\n\n'));
  }

  String _extractLikelyReasoningPreamble(String reply, String visibleAnswer) {
    final clean = reply.trim();
    if (clean.isEmpty || clean == visibleAnswer.trim()) return '';
    if (clean.startsWith('{')) return '';
    final marker = RegExp(r'(^|\n)\s*(Plan:|Analysis:|Reasoning:)', caseSensitive: false).firstMatch(clean);
    if (marker == null && !RegExp(r'^\s*The user said', caseSensitive: false).hasMatch(clean)) return '';
    final answerIndex = clean.indexOf(visibleAnswer.trim());
    final preamble = answerIndex > 0 ? clean.substring(0, answerIndex).trim() : clean;
    return _sanitizeModelSideChannel(preamble);
  }

  String _sanitizeModelSideChannel(String text) {
    var clean = text.trim();
    if (clean.isEmpty) return '';
    clean = clean.replaceAll(RegExp(r'```(?:json)?\s*', caseSensitive: false), '').replaceAll('```', '').trim();
    if (clean.length > 2400) {
      clean = '${clean.substring(0, 2400).trimRight()}\n…';
    }
    return clean;
  }

  String _fallbackVisibleAnswer(String reply) {
    final decoded = _decodeProtocolObject(reply);
    if (decoded != null && decoded['answer'] != null) return decoded['answer'].toString().trim();
    var clean = reply.trim();
    final jsonObject = _extractLastJsonObject(clean);
    if (jsonObject != null) clean = clean.replaceAll(jsonObject, '').trim();
    if (clean.startsWith('{') && clean.contains('normal_answer')) {
      return 'I received your message, but the model returned a malformed protocol response. Please try again.';
    }
    if (RegExp(r'^\s*(the user said|plan:|analysis:)', caseSensitive: false).hasMatch(clean)) {
      return 'I received your message.';
    }
    return clean.isEmpty ? 'I received your message.' : clean;
  }


  String _stripCodeFence(String text) {
    var clean = text.trim();
    if (clean.startsWith('```')) {
      clean = clean.replaceFirst(RegExp(r'^```(?:json)?\s*'), '');
      clean = clean.replaceFirst(RegExp(r'\s*```$'), '');
    }
    return clean.trim();
  }
}

class _HermesToolObservation {
  final HermesToolResult result;
  final List<HermesEvent> events;

  const _HermesToolObservation({
    required this.result,
    required this.events,
  });
}

