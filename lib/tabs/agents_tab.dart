part of ssh_dashboard;

/* =========================================================
   Agents Tab: chat UI backed by hidden PTY terminal
========================================================= */


class _AgentLauncher {
  final String name;
  final String command;

  const _AgentLauncher({
    required this.name,
    required this.command,
  });
}

class _AgentLauncherDialog extends StatefulWidget {
  const _AgentLauncherDialog();

  @override
  State<_AgentLauncherDialog> createState() => _AgentLauncherDialogState();
}

class _AgentLauncherDialogState extends State<_AgentLauncherDialog> {
  final nameController = TextEditingController();
  final commandController = TextEditingController();

  @override
  void dispose() {
    nameController.dispose();
    commandController.dispose();
    super.dispose();
  }

  void submit() {
    final name = nameController.text.trim();
    final command = commandController.text.trim();

    if (name.isEmpty || command.isEmpty) return;

    Navigator.of(context).pop(
      _AgentLauncher(name: name, command: command),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New custom agent'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: const InputDecoration(
                labelText: 'Display name',
                hintText: 'Example: OpenClaw',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: commandController,
              decoration: const InputDecoration(
                labelText: 'Launch command',
                hintText: 'Example: openclaw',
              ),
              onSubmitted: (_) => submit(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: submit,
          child: const Text('Create'),
        ),
      ],
    );
  }
}

class _AgentWorkspace {
  final String id;
  String title;
  String agentName;
  String agentCommand;
  String pwd;
  final TextEditingController pwdController;
  final TextEditingController promptController = TextEditingController();
  final FocusNode inputFocusNode = FocusNode();
  final ScrollController scrollController = ScrollController();
  late final TerminalController controller;

  SSHSession? session;
  StreamSubscription<Uint8List>? stdoutSub;
  StreamSubscription<Uint8List>? stderrSub;
  Terminal? hiddenTerminal;
  Timer? idleTimer;

  bool starting = false;
  bool ready = false;
  bool streaming = false;
  bool resumeFlow = false;
  int suppressChoicesUntilMs = 0;

  String draft = '';
  String screenText = '';
  String lastAssistantScreenText = '';
  List<AgentMessage> messages = [];
  List<AgentSuggestion> suggestions = [];
  List<AgentChoice> choices = [];

  _AgentWorkspace({
    required this.id,
    required this.title,
    required this.agentName,
    required this.agentCommand,
    this.pwd = '~',
  }) : pwdController = TextEditingController(text: pwd);

  Future<void> dispose() async {
    idleTimer?.cancel();
    await stdoutSub?.cancel();
    await stderrSub?.cancel();
    session?.close();
    pwdController.dispose();
    promptController.dispose();
    inputFocusNode.dispose();
    scrollController.dispose();
  }
}

class AgentsTab extends StatefulWidget {
  const AgentsTab({super.key});

  @override
  State<AgentsTab> createState() => _AgentsTabState();
}

class _AgentsTabState extends State<AgentsTab> with AutomaticKeepAliveClientMixin<AgentsTab> {
  final List<_AgentWorkspace> workspaces = [];
  int selectedIndex = 0;
  int counter = 0;
  bool ignoreControllerChange = false;

  _AgentWorkspace get current => workspaces[selectedIndex];

  @override
  void initState() {
    super.initState();
    addAgentPage(agentName: 'Codex', autoStart: false);
  }

  @override
  void dispose() {
    for (final workspace in workspaces) {
      workspace.dispose();
    }
    super.dispose();
  }

  @override
  bool get wantKeepAlive => true;

  static const List<_AgentLauncher> defaultAgentLaunchers = [
    _AgentLauncher(name: 'Codex', command: 'codex'),
    _AgentLauncher(name: 'Gemini', command: 'gemini'),
    _AgentLauncher(name: 'Claude', command: 'claude'),
    _AgentLauncher(name: 'OpenClaw', command: 'openclaw'),
    _AgentLauncher(name: 'OpenCode', command: 'opencode'),
  ];

  String _commandForAgent(String name) {
    final normalized = name.trim().toLowerCase();
    for (final launcher in defaultAgentLaunchers) {
      if (launcher.name.toLowerCase() == normalized) return launcher.command;
    }
    return normalized.replaceAll(RegExp(r'\s+'), '-');
  }

  String _quoteShellArg(String value) {
    return "'${value.replaceAll("'", "'\"'\"'")}'";
  }

  Future<void> addCustomAgentPage() async {
    final launcher = await showDialog<_AgentLauncher>(
      context: context,
      builder: (_) => const _AgentLauncherDialog(),
    );

    if (launcher == null) return;

    addAgentPage(
      agentName: launcher.name,
      agentCommand: launcher.command,
      autoStart: true,
    );
  }

  void addAgentPage({
    required String agentName,
    String? agentCommand,
    String? initialPwd,
    String? initialPrompt,
    bool autoStart = false,
  }) {
    counter += 1;
    final providerPwd = context.read<SSHProvider>().sharedPwd;
    final workspacePwd = (initialPwd == null || initialPwd.trim().isEmpty)
        ? providerPwd
        : initialPwd.trim();
    final workspace = _AgentWorkspace(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      title: '$agentName $counter',
      agentName: agentName,
      agentCommand: agentCommand ?? _commandForAgent(agentName),
      pwd: workspacePwd,
    );

    final prompt = initialPrompt?.trim();
    if (prompt != null && prompt.isNotEmpty) {
      workspace.promptController.text = prompt;
    }

    workspace.hiddenTerminal = Terminal(
      maxLines: 10000,
      platform: currentTerminalTargetPlatform(),
      onOutput: (data) {
        final session = workspace.session;
        if (session == null) return;
        session.write(Uint8List.fromList(utf8.encode(data)));
      },
      onResize: (width, height, pixelWidth, pixelHeight) {
        final session = workspace.session;
        if (session == null) return;
        session.resizeTerminal(width, height, pixelWidth, pixelHeight);
      },
    );
    workspace.hiddenTerminal!.resize(100, 30);
    workspace.controller = TerminalController();

    setState(() {
      workspaces.add(workspace);
      selectedIndex = workspaces.length - 1;
    });

    if (autoStart) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        startAgent(workspace);
      });
    }
  }

  void openTaskInAgent(TaskItem task, {bool autoStart = false}) {
    addAgentPage(
      agentName: task.effectiveAgentName,
      agentCommand: task.agentCommand,
      initialPwd: task.cwd,
      initialPrompt: task.effectivePrompt,
      autoStart: autoStart,
    );
  }

  Future<void> createQueueTask() async {
    final provider = context.read<SSHProvider>();
    final task = await showDialog<TaskItem>(
      context: context,
      builder: (_) => _TaskQueueDialog(
        defaultCwd: provider.sharedPwd,
        gpus: provider.gpus,
      ),
    );

    if (task == null) return;

    try {
      await provider.addTask(task);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Task queued: ${task.title}')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Unable to queue task: $e')),
      );
    }
  }

  Future<void> launchQueueTask(TaskItem task) async {
    final provider = context.read<SSHProvider>();
    try {
      if (task.hasLaunchCommand) {
        await provider.launchTask(task);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Launched: ${task.title}')),
        );
        return;
      }
      openTaskInAgent(task, autoStart: true);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Launch failed: $e')),
      );
    }
  }

  Future<void> cancelQueueTask(TaskItem task) async {
    final provider = context.read<SSHProvider>();
    try {
      await provider.cancelTask(task);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Cancelled: ${task.title}')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Cancel failed: $e')),
      );
    }
  }

  Future<void> deleteQueueTask(TaskItem task) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete task?'),
        content: Text('Remove "${task.title}" from the queue? This does not delete logs.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;

    try {
      await context.read<SSHProvider>().deleteTask(task);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Delete failed: $e')),
      );
    }
  }

  Future<void> closeCurrentPage() async {
    if (workspaces.length <= 1) return;
    final removed = workspaces.removeAt(selectedIndex);
    await removed.dispose();
    setState(() {
      selectedIndex = selectedIndex.clamp(0, workspaces.length - 1).toInt();
    });
  }

  Future<void> startAgent(_AgentWorkspace workspace) async {
    if (workspace.starting) return;

    final client = context.read<SSHProvider>().client;
    if (client == null || client.isClosed) {
      _addSystemMessage(workspace, 'SSH 尚未連線，無法啟動 agent。');
      return;
    }

    await stopAgent(workspace, silent: true);

    setState(() {
      workspace.starting = true;
      workspace.ready = false;
      workspace.streaming = false;
      workspace.draft = '';
      workspace.screenText = '';
      workspace.suggestions = [];
      workspace.choices = [];
      workspace.lastAssistantScreenText = '';
    });

    _addSystemMessage(workspace, 'Starting ${workspace.agentName} session...');

    try {
      final terminal = workspace.hiddenTerminal!;
      terminal.write('\r\n[Starting ${workspace.agentName} in ${workspace.pwd}]\r\n');
      final width = terminal.viewWidth > 0 ? terminal.viewWidth : 100;
      final height = terminal.viewHeight > 0 ? terminal.viewHeight : 30;

      final session = await client.shell(
        pty: SSHPtyConfig(
          type: 'xterm-256color',
          width: width,
          height: height,
        ),
      );

      workspace.session = session;

      workspace.stdoutSub = session.stdout.listen(
        (data) {
          final text = utf8.decode(data, allowMalformed: true);
          workspace.hiddenTerminal?.write(text);
          _refreshAgentUi(workspace);
        },
        onError: (error) => _addSystemMessage(workspace, 'agent stdout error: $error'),
      );

      workspace.stderrSub = session.stderr.listen(
        (data) {
          final text = utf8.decode(data, allowMalformed: true);
          workspace.hiddenTerminal?.write(text);
          _refreshAgentUi(workspace);
        },
        onError: (error) => _addSystemMessage(workspace, 'agent stderr error: $error'),
      );

      session.done.then((_) {
        if (!mounted) return;
        setState(() {
          workspace.ready = false;
          workspace.streaming = false;
          workspace.session = null;
        });
        _addSystemMessage(workspace, '${workspace.agentName} session closed.');
      });

      await Future.delayed(const Duration(milliseconds: 250));
      final quotedPwd = _quoteShellArg(workspace.pwd);
      final startCommand = 'target=$quotedPwd; case "\$target" in "~") target="\$HOME" ;; "~/"*) target="\$HOME/\${target#~/}" ;; esac; cd "\$target" && ${workspace.agentCommand}';
      session.write(Uint8List.fromList(utf8.encode('$startCommand\r')));

      setState(() {
        workspace.starting = false;
        workspace.ready = true;
      });

      _addSystemMessage(
        workspace,
        '${workspace.agentName} session started. This page is independent; switch pages above without closing sessions.',
      );
    } catch (e) {
      setState(() {
        workspace.starting = false;
        workspace.ready = false;
      });
      _addSystemMessage(workspace, 'Agent session 啟動失敗：$e');
    }
  }

  Future<void> stopAgent(_AgentWorkspace workspace, {bool silent = false}) async {
    workspace.idleTimer?.cancel();
    workspace.idleTimer = null;
    await workspace.stdoutSub?.cancel();
    await workspace.stderrSub?.cancel();
    workspace.stdoutSub = null;
    workspace.stderrSub = null;

    try {
      workspace.session?.write(Uint8List.fromList([3]));
      await Future.delayed(const Duration(milliseconds: 80));
      workspace.session?.close();
    } catch (_) {}

    workspace.session = null;

    setState(() {
      workspace.ready = false;
      workspace.starting = false;
      workspace.streaming = false;
      workspace.draft = '';
      workspace.suggestions = [];
      workspace.choices = [];
      workspace.screenText = '';
      workspace.lastAssistantScreenText = '';
    });

    if (!silent) {
      _addSystemMessage(workspace, '${workspace.agentName} session stopped.');
    }
  }

  void applyPwd(_AgentWorkspace workspace) {
    final pwd = workspace.pwdController.text.trim().isEmpty
        ? '~'
        : workspace.pwdController.text.trim();
    workspace.pwd = pwd;
    if (workspace.ready && workspace.session != null) {
      final quotedPwd = _quoteShellArg(pwd);
      workspace.session!.write(Uint8List.fromList(utf8.encode('target=$quotedPwd; case "\$target" in "~") target="\$HOME" ;; "~/"*) target="\$HOME/\${target#~/}" ;; esac; cd "\$target" && pwd\r')));
      _addSystemMessage(workspace, 'PWD changed to $pwd');
    } else {
      _addSystemMessage(workspace, 'PWD for next start: $pwd');
    }
    setState(() {});
  }

  void _addSystemMessage(_AgentWorkspace workspace, String text) {
    workspace.messages.add(
      AgentMessage(role: 'system', text: text, time: DateTime.now()),
    );
    workspace.hiddenTerminal?.write('\r\n[$text]\r\n');
    if (mounted) setState(() {});
  }

  void syncDraft(_AgentWorkspace workspace, String nextDraft) {
    // Important: only slash commands need live sync because the CLI shows slash menus while typing.
    // Normal text is sent only after tapping Send, avoiding accidental trust/number selection.
    if (!nextDraft.trimLeft().startsWith('/')) {
      setState(() {
        workspace.draft = nextDraft;
        workspace.suggestions = [];
      });
      return;
    }

    final session = workspace.session;
    if (session == null || !workspace.ready) {
      setState(() {
        workspace.draft = nextDraft;
        workspace.suggestions = _extractSuggestions(workspace, workspace.screenText);
      });
      return;
    }

    final patch = _buildTerminalInputPatch(workspace.draft, nextDraft);
    if (patch.isNotEmpty) {
      session.write(Uint8List.fromList(utf8.encode(patch)));
    }

    setState(() {
      workspace.draft = nextDraft;
      workspace.suggestions = _extractSuggestions(workspace, workspace.screenText);
      workspace.choices = [];
    });
  }

  String _buildTerminalInputPatch(String oldText, String newText) {
    if (oldText == newText) return '';
    if (newText.startsWith(oldText)) return newText.substring(oldText.length);
    if (oldText.startsWith(newText)) {
      return List.filled(oldText.length - newText.length, '\x7f').join();
    }
    return '\x15$newText';
  }

  Future<void> submitDraft(_AgentWorkspace workspace) async {
    final session = workspace.session;
    if (session == null || !workspace.ready) {
      _addSystemMessage(workspace, 'Agent session 尚未啟動。');
      return;
    }

    final text = workspace.draft.trim();
    if (text.isEmpty) return;

    if (text == '/resume') {
      workspace.messages.clear();
      workspace.lastAssistantScreenText = '';
      workspace.resumeFlow = true;
      workspace.messages.add(
        AgentMessage(
          role: 'system',
          text: 'Resume mode: select a previous session from the options below.',
          time: DateTime.now(),
        ),
      );
    } else {
      workspace.messages.add(
        AgentMessage(role: 'user', text: text, time: DateTime.now()),
      );
    }

    workspace.draft = '';
    workspace.suggestions = [];
    workspace.choices = [];
    workspace.streaming = true;
    ignoreControllerChange = true;
    workspace.promptController.clear();

    session.write(Uint8List.fromList(utf8.encode('\r')));
    setState(() {});
  }

  void applySuggestion(_AgentWorkspace workspace, AgentSuggestion suggestion) {
    ignoreControllerChange = true;
    workspace.promptController.text = suggestion.insertText;
    workspace.promptController.selection = TextSelection.collapsed(
      offset: workspace.promptController.text.length,
    );
    syncDraft(workspace, suggestion.insertText);
    submitDraft(workspace);
  }

  void submitAgentInput(_AgentWorkspace workspace, {bool appendEnter = true}) {
    final session = workspace.session;
    if (session == null || !workspace.ready) return;

    final text = workspace.promptController.text;
    if (text.isEmpty && !appendEnter) return;

    session.write(Uint8List.fromList(utf8.encode(appendEnter ? '$text\r' : text)));
    workspace.promptController.clear();
    workspace.inputFocusNode.requestFocus();
    setState(() {
      workspace.draft = '';
      workspace.suggestions = [];
      workspace.choices = [];
      workspace.streaming = true;
    });
  }

  void applyChoice(_AgentWorkspace workspace, AgentChoice choice) {
    final session = workspace.session;
    if (session == null || !workspace.ready) return;

    if (workspace.resumeFlow) {
      workspace.messages.clear();
      workspace.messages.add(
        AgentMessage(
          role: 'system',
          text: 'Loading resumed session: ${choice.label}',
          time: DateTime.now(),
        ),
      );
      workspace.lastAssistantScreenText = '';
      workspace.resumeFlow = false;
    }

    if (choice.useArrowNavigation) {
      final buffer = StringBuffer();
      for (int i = 0; i < choice.arrowDownCount; i++) {
        buffer.write('\x1b[B');
      }
      buffer.write('\r');
      session.write(Uint8List.fromList(utf8.encode(buffer.toString())));
    } else {
      session.write(Uint8List.fromList(utf8.encode('${choice.sendText}\r')));
    }

    workspace.suppressChoicesUntilMs = DateTime.now().millisecondsSinceEpoch + 900;
    setState(() {
      workspace.choices = [];
      workspace.streaming = true;
    });
  }

  void _refreshAgentUi(_AgentWorkspace workspace) {
    final terminal = workspace.hiddenTerminal;
    if (terminal == null) return;

    final screen = _readHiddenTerminalScreen(terminal);
    final assistantText = _extractAssistantText(screen);
    final nowMs = DateTime.now().millisecondsSinceEpoch;

    setState(() {
      workspace.screenText = screen;
      workspace.suggestions = _extractSuggestions(workspace, screen);
      workspace.choices = nowMs < workspace.suppressChoicesUntilMs
          ? []
          : _extractChoices(screen, workspace.resumeFlow);

      if (assistantText.trim().isNotEmpty &&
          assistantText.trim() != workspace.lastAssistantScreenText.trim()) {
        workspace.lastAssistantScreenText = assistantText;
        _upsertAssistantMessage(workspace, assistantText);
      }

      workspace.streaming = true;
    });

    workspace.idleTimer?.cancel();
    workspace.idleTimer = Timer(const Duration(milliseconds: 900), () {
      if (!mounted) return;
      setState(() {
        workspace.streaming = false;
        if (!workspace.draft.trimLeft().startsWith('/')) {
          workspace.suggestions = [];
        }
      });
    });
  }

  String _readHiddenTerminalScreen(Terminal terminal) {
    final lines = <String>[];
    final width = terminal.viewWidth > 0 ? terminal.viewWidth : 100;
    for (int i = 0; i < terminal.lines.length; i++) {
      final line = terminal.lines[i];
      final text = line.getText(0, width).trimRight();
      if (text.trim().isEmpty) continue;
      lines.add(text);
    }
    return lines.join('\n');
  }

  List<AgentSuggestion> _extractSuggestions(_AgentWorkspace workspace, String screen) {
    final query = workspace.draft.trim();
    if (!query.startsWith('/')) return [];

    final merged = <String, AgentSuggestion>{};
    for (final item in _localSlashSuggestions(query)) {
      merged[item.insertText] = item;
    }
    for (final item in _dynamicSlashSuggestionsFromScreen(screen, query)) {
      merged[item.insertText] = item;
    }
    return merged.values.toList();
  }

  List<AgentSuggestion> _localSlashSuggestions(String query) {
    const all = <AgentSuggestion>[
      AgentSuggestion(label: '/help', description: 'Show available commands', insertText: '/help'),
      AgentSuggestion(label: '/resume', description: 'Resume a previous conversation/session', insertText: '/resume'),
      AgentSuggestion(label: '/clear', description: 'Clear current conversation if supported', insertText: '/clear'),
      AgentSuggestion(label: '/compact', description: 'Compact or summarize context if supported', insertText: '/compact'),
      AgentSuggestion(label: '/model', description: 'Change model if supported by the CLI', insertText: '/model'),
      AgentSuggestion(label: '/status', description: 'Show current agent status if supported', insertText: '/status'),
      AgentSuggestion(label: '/init', description: 'Initialize project context if supported', insertText: '/init'),
      AgentSuggestion(label: '/login', description: 'Login/auth flow if supported', insertText: '/login'),
      AgentSuggestion(label: '/logout', description: 'Logout/auth reset if supported', insertText: '/logout'),
      AgentSuggestion(label: '/settings', description: 'Open settings if supported', insertText: '/settings'),
      AgentSuggestion(label: '/review', description: 'Review changes if supported', insertText: '/review'),
      AgentSuggestion(label: '/diff', description: 'Show diff if supported', insertText: '/diff'),
      AgentSuggestion(label: '/plan', description: 'Plan mode if supported', insertText: '/plan'),
      AgentSuggestion(label: '/approvals', description: 'Approval settings if supported', insertText: '/approvals'),
      AgentSuggestion(label: '/quit', description: 'Exit current agent session if supported', insertText: '/quit'),
      AgentSuggestion(label: '/exit', description: 'Exit current agent session if supported', insertText: '/exit'),
    ];

    final needle = query.toLowerCase();
    return all.where((item) {
      final label = item.label.toLowerCase();
      return label.startsWith(needle) || label.contains(needle.replaceFirst('/', ''));
    }).toList();
  }

  List<AgentSuggestion> _dynamicSlashSuggestionsFromScreen(String screen, String query) {
    final result = <AgentSuggestion>[];
    final q = query.toLowerCase();
    for (final raw in const LineSplitter().convert(screen)) {
      final line = raw.trim();
      // First attempt to match a slash command with an optional description
      // separated by a dash/colon or by one or more spaces.
      final slashWithDesc = RegExp(
        // Allow commands to be preceded by simple bullet prefixes (>, ›, •, -, *).
        r'^(?:[>›•\-*]\s*)?(\/[-a-zA-Z0-9_]+)\s*(?:[-:–—]\s*|\s+)(.*)$',
      ).firstMatch(line);
      if (slashWithDesc != null) {
        final cmd = slashWithDesc.group(1) ?? '';
        final desc = slashWithDesc.group(2) ?? '';
        if (cmd.isNotEmpty) {
          final lower = cmd.toLowerCase();
          if (lower.startsWith(q) || lower.contains(q.replaceFirst('/', ''))) {
            result.add(AgentSuggestion(label: cmd, description: desc, insertText: cmd));
          }
        }
        continue;
      }
      // Fallback: match a slash command with no description.
      final singleCmd = RegExp(
        // Same bullet prefix as above for commands without descriptions.
        r'^(?:[>›•\-*]\s*)?(\/[-a-zA-Z0-9_]+)\s*$',
      ).firstMatch(line);
      if (singleCmd != null) {
        final cmd = singleCmd.group(1) ?? '';
        if (cmd.isNotEmpty) {
          final lower = cmd.toLowerCase();
          if (lower.startsWith(q) || lower.contains(q.replaceFirst('/', ''))) {
            result.add(AgentSuggestion(label: cmd, description: '', insertText: cmd));
          }
        }
        continue;
      }
    }
    return result;
  }

  List<AgentChoice> _extractChoices(String screen, bool resumeFlow) {
    final lines = const LineSplitter().convert(screen);
    final choices = <AgentChoice>[];
    int arrowIndex = 0;

    for (final raw in lines) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      if (_isNoiseChoiceLine(line)) continue;

      // Match numbered choices like "1. Option" or "(2) Option". Limit the number to 1 or 2 digits and
      // require a delimiter (., :, -, or )) followed by at least one space before the label.
      final numeric = RegExp(r'^(?:[>›•\-*]\s*)?(?:\(?\[?)(\d{1,2})(?:\)?\]?)[\.\):\-]\s+(.+)$')
          .firstMatch(line);
      if (numeric != null) {
        final number = numeric.group(1) ?? '';
        final label = (numeric.group(2) ?? '').trim();
        if (label.isNotEmpty) {
          choices.add(AgentChoice(label: label, sendText: number));
        }
        continue;
      }

      final yesNo = RegExp(r'^(?:[>›•\-*]\s*)?\[?\s*([yn])\s*\]?\s+(.+)$', caseSensitive: false)
          .firstMatch(line);
      if (yesNo != null) {
        final key = yesNo.group(1) ?? '';
        final label = (yesNo.group(2) ?? '').trim();
        final send = key.toLowerCase();
        final displayLabel = label.isNotEmpty ? label : key;
        choices.add(AgentChoice(label: displayLabel, sendText: send));
        continue;
      }

      final arrow = RegExp(r'^(?:[>›]+)\s*(.+)$').firstMatch(line);
      if (arrow != null) {
        final label = (arrow.group(1) ?? '').trim();
        if (label.isNotEmpty) {
          choices.add(
            AgentChoice(
              label: label,
              sendText: '',
              useArrowNavigation: true,
              arrowDownCount: arrowIndex,
            ),
          );
          arrowIndex += 1;
        }
        continue;
      }

      // Resume session lists often show timestamp/title rows without numeric prefixes.
      if (resumeFlow && _looksLikeResumeSessionRow(line)) {
        choices.add(
          AgentChoice(
            label: line,
            sendText: '',
            useArrowNavigation: true,
            arrowDownCount: choices.length,
          ),
        );
      }
    }

    // Keep the panel useful, not endless.
    final unique = <String, AgentChoice>{};
    for (final choice in choices) {
      unique[choice.label] = choice;
    }
    return unique.values.take(20).toList();
  }

  bool _looksLikeResumeSessionRow(String line) {
    final lower = line.toLowerCase();
    if (lower.contains('resume') || lower.contains('session')) return false;
    if (RegExp(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}').hasMatch(line)) return true;
    if (RegExp(r'\d{1,2}:\d{2}').hasMatch(line)) return true;
    return line.length > 12 && line.length < 120;
  }

  bool _isNoiseChoiceLine(String line) {
    // Normalize and trim for easier analysis.
    final trimmed = line.trim();
    final lower = trimmed.toLowerCase();
    // Treat slash commands at the start of a line (even if preceded by bullets) as noise.
    // Many CLI menus prefix slash commands with characters like >, ›, •, -, * before the
    // slash.  Ignore these prefixes when checking for slash commands.
    if (RegExp(r'^(?:[>›•\-*]\s*)?/').hasMatch(trimmed)) {
      return true;
    }
    // Lines prompting the user to press escape or type a slash command should be ignored.
    if (lower.startsWith('press esc')) return true;
    if (lower.startsWith('type /')) return true;
    // Terminal control hints can be ignored in choice detection.
    if (lower.contains('ctrl+c')) return true;
    if (lower.contains('ctrl-d')) return true;
    // Ignore loading and thinking messages only if they start the line.
    if (lower.startsWith('loading')) return true;
    if (lower.startsWith('thinking')) return true;
    // Ignore simple agent name echoes.
    if (lower == 'codex' || lower == 'gemini') return true;
    // Lines starting with a shell prompt should not be treated as choices.
    if (lower.startsWith(r'$ ')) return true;
    return false;
  }

  String _extractAssistantText(String screen) {
    final visible = <String>[];
    for (final raw in const LineSplitter().convert(screen)) {
      final line = raw.trimRight();
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      if (_isNoiseAgentLine(trimmed)) continue;
      visible.add(line);
    }
    final split = visible.length > 80 ? visible.sublist(visible.length - 80) : visible;
    return split.join('\n').trim();
  }

  bool _isNoiseAgentLine(String line) {
    // Treat slash commands as noise in the agent UI.  A slash command may be
    // preceded by simple bullet characters such as >, ›, •, -, *.  Ignore these prefixes.
    if (RegExp(r'^(?:[>›•\-*]\s*)?\/[a-zA-Z0-9_\-]+').hasMatch(line)) {
      return true;
    }
    if (_isNoiseChoiceLine(line)) return true;
    return false;
  }

  void _upsertAssistantMessage(_AgentWorkspace workspace, String text) {
    if (workspace.messages.isNotEmpty && workspace.messages.last.role == 'assistant') {
      final last = workspace.messages.removeLast();
      workspace.messages.add(AgentMessage(role: 'assistant', text: text, time: last.time));
    } else {
      workspace.messages.add(AgentMessage(role: 'assistant', text: text, time: DateTime.now()));
    }
  }

  void _scrollToBottom(_AgentWorkspace workspace) {
    final controller = workspace.scrollController;
    if (!controller.hasClients) return;
    controller.animateTo(
      controller.position.maxScrollExtent,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final provider = context.watch<SSHProvider>();
    final workspace = current;

    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom(workspace));

    return Row(
      children: [
        SizedBox(
          width: 332,
          child: _AgentStudioSidebar(
            tasks: provider.tasks,
            workspaces: workspaces,
            selectedIndex: selectedIndex,
            launchers: defaultAgentLaunchers,
            onSelectWorkspace: (index) => setState(() => selectedIndex = index),
            onNewAgent: (launcher) => addAgentPage(
              agentName: launcher.name,
              agentCommand: launcher.command,
              autoStart: true,
            ),
            onNewCustomAgent: addCustomAgentPage,
            onCreateTask: createQueueTask,
            onOpenTask: (task) => openTaskInAgent(task),
            onStartTask: (task) => launchQueueTask(task),
            onCancelTask: (task) => cancelQueueTask(task),
            onDeleteTask: (task) => deleteQueueTask(task),
            onRefresh: provider.refreshAll,
          ),
        ),
        const VerticalDivider(width: 1),
        Expanded(
          child: Column(
            children: [
        Container(
          color: const Color(0xFF111827),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (int i = 0; i < workspaces.length; i++) ...[
                      ChoiceChip(
                        label: Text(workspaces[i].title),
                        selected: i == selectedIndex,
                        onSelected: (_) => setState(() => selectedIndex = i),
                      ),
                      const SizedBox(width: 8),
                    ],
                    PopupMenuButton<String>(
                      tooltip: 'New Agent Page',
                      onSelected: (name) {
                        if (name == '__custom__') {
                          addCustomAgentPage();
                          return;
                        }
                        addAgentPage(agentName: name, autoStart: true);
                      },
                      itemBuilder: (context) => [
                        for (final launcher in defaultAgentLaunchers)
                          PopupMenuItem(
                            value: launcher.name,
                            child: Text('New ${launcher.name} page'),
                          ),
                        const PopupMenuDivider(),
                        const PopupMenuItem(
                          value: '__custom__',
                          child: Text('New custom agent...'),
                        ),
                      ],
                      child: const Chip(
                        avatar: Icon(Icons.add, size: 18),
                        label: Text('New Agent'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    ActionChip(
                      avatar: const Icon(Icons.close, size: 18),
                      label: const Text('Close'),
                      onPressed: workspaces.length > 1 ? closeCurrentPage : null,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  SizedBox(
                    width: 220,
                    child: TextField(
                      controller: workspace.pwdController,
                      decoration: const InputDecoration(
                        labelText: 'Agent PWD',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onSubmitted: (_) => applyPwd(workspace),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonal(
                    onPressed: () => applyPwd(workspace),
                    child: const Text('Apply'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              _AgentToolbar(
                agentName: workspace.agentName,
                isStarting: workspace.starting,
                isReady: workspace.ready,
                isStreaming: workspace.streaming,
                onStart: () => startAgent(workspace),
                onStop: () => stopAgent(workspace),
                onClear: () {
                  setState(() {
                    workspace.messages.clear();
                    workspace.lastAssistantScreenText = '';
                    workspace.hiddenTerminal?.eraseDisplay();
                    workspace.hiddenTerminal?.setCursor(0, 0);
                  });
                },
              ),
            ],
          ),
        ),
        Expanded(
          child: Container(
            color: Colors.black,
            child: TerminalView(
              workspace.hiddenTerminal!,
              controller: workspace.controller,
              autofocus: true,
              deleteDetection: true,
              keyboardType: TextInputType.text,
              keyboardAppearance: Brightness.dark,
              cursorType: TerminalCursorType.block,
              alwaysShowCursor: true,
              backgroundOpacity: 1,
              padding: const EdgeInsets.all(8),
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Container(
            color: const Color(0xFF0B0F14),
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: workspace.promptController,
                    focusNode: workspace.inputFocusNode,
                    enabled: workspace.ready,
                    keyboardType: TextInputType.text,
                    textInputAction: TextInputAction.send,
                    decoration: InputDecoration(
                      hintText: workspace.ready
                          ? '${workspace.agentName} terminal input / 支援中文輸入'
                          : 'Start this agent page first',
                      border: const OutlineInputBorder(),
                      isDense: true,
                    ),
                    onSubmitted: (_) => submitAgentInput(workspace),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: workspace.ready ? () => submitAgentInput(workspace) : null,
                  child: const Icon(Icons.keyboard_return),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: workspace.ready ? () => workspace.session?.write(Uint8List.fromList([27])) : null,
                  child: const Text('Esc'),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: workspace.ready ? () => workspace.session?.write(Uint8List.fromList([3])) : null,
                  child: const Text('Interrupt'),
                ),
              ],
            ),
          ),
        ),
            ],
          ),
        ),
      ],
    );
  }
}

class _AgentStudioSidebar extends StatelessWidget {
  final List<TaskItem> tasks;
  final List<_AgentWorkspace> workspaces;
  final int selectedIndex;
  final List<_AgentLauncher> launchers;
  final ValueChanged<int> onSelectWorkspace;
  final ValueChanged<_AgentLauncher> onNewAgent;
  final VoidCallback onNewCustomAgent;
  final VoidCallback onCreateTask;
  final ValueChanged<TaskItem> onOpenTask;
  final ValueChanged<TaskItem> onStartTask;
  final ValueChanged<TaskItem> onCancelTask;
  final ValueChanged<TaskItem> onDeleteTask;
  final Future<void> Function() onRefresh;

  const _AgentStudioSidebar({
    required this.tasks,
    required this.workspaces,
    required this.selectedIndex,
    required this.launchers,
    required this.onSelectWorkspace,
    required this.onNewAgent,
    required this.onNewCustomAgent,
    required this.onCreateTask,
    required this.onOpenTask,
    required this.onStartTask,
    required this.onCancelTask,
    required this.onDeleteTask,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFF0F172A),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 10),
            child: Row(
              children: [
                const Icon(Icons.hub, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Agent Studio',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: 'Refresh tasks',
                  onPressed: () => onRefresh(),
                  icon: const Icon(Icons.refresh, size: 20),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
              children: [
                _SidebarSectionLabel(
                  icon: Icons.tab,
                  label: 'Sessions (${workspaces.length})',
                ),
                const SizedBox(height: 8),
                for (int i = 0; i < workspaces.length; i++)
                  _AgentSessionTile(
                    workspace: workspaces[i],
                    selected: i == selectedIndex,
                    onTap: () => onSelectWorkspace(i),
                  ),
                const SizedBox(height: 18),
                const _SidebarSectionLabel(
                  icon: Icons.auto_awesome,
                  label: 'Agent presets',
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final launcher in launchers)
                      ActionChip(
                        avatar: const Icon(Icons.smart_toy, size: 16),
                        label: Text(launcher.name),
                        onPressed: () => onNewAgent(launcher),
                      ),
                    ActionChip(
                      avatar: const Icon(Icons.add, size: 16),
                      label: const Text('Custom'),
                      onPressed: onNewCustomAgent,
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    Expanded(
                      child: _SidebarSectionLabel(
                        icon: Icons.task_alt,
                        label: 'Task queue (${tasks.length})',
                      ),
                    ),
                    IconButton(
                      tooltip: 'Create queue task',
                      onPressed: onCreateTask,
                      icon: const Icon(Icons.add_task, size: 20),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                FilledButton.icon(
                  onPressed: onCreateTask,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('New DL task'),
                ),
                const SizedBox(height: 10),
                if (tasks.isEmpty)
                  const InfoCard(
                    text: 'No queued tasks. Create one for manual launch, scheduled launch, or wait-for-idle GPU launch.',
                  )
                else
                  for (final task in tasks)
                    _AgentTaskTile(
                      task: task,
                      onOpen: () => onOpenTask(task),
                      onStart: () => onStartTask(task),
                      onCancel: () => onCancelTask(task),
                      onDelete: () => onDeleteTask(task),
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SidebarSectionLabel extends StatelessWidget {
  final IconData icon;
  final String label;

  const _SidebarSectionLabel({
    required this.icon,
    required this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 16, color: AppPalette.accent),
        const SizedBox(width: 6),
        Text(
          label,
          style: Theme.of(context).textTheme.labelLarge?.copyWith(
                color: AppPalette.accent,
                fontWeight: FontWeight.w700,
              ),
        ),
      ],
    );
  }
}

class _AgentSessionTile extends StatelessWidget {
  final _AgentWorkspace workspace;
  final bool selected;
  final VoidCallback onTap;

  const _AgentSessionTile({
    required this.workspace,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = workspace.starting
        ? Colors.orangeAccent
        : workspace.ready
            ? Colors.greenAccent
            : Colors.redAccent;

    return Card(
      color: selected ? const Color(0xFF1E293B) : const Color(0xFF111827),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: selected ? AppPalette.accent.withOpacity(0.55) : AppPalette.border),
      ),
      child: ListTile(
        dense: true,
        onTap: onTap,
        leading: Icon(Icons.terminal, color: color, size: 20),
        title: Text(
          workspace.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Text(
          '${workspace.agentCommand} · ${workspace.pwd}',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }
}

class _AgentTaskTile extends StatelessWidget {
  final TaskItem task;
  final VoidCallback onOpen;
  final VoidCallback onStart;
  final VoidCallback onCancel;
  final VoidCallback onDelete;

  const _AgentTaskTile({
    required this.task,
    required this.onOpen,
    required this.onStart,
    required this.onCancel,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(task.status);
    final meta = <String>[];
    meta.add(task.displayLaunchMode);
    if (task.targetGpuIndex != null) meta.add('GPU ${task.targetGpuIndex}');
    if (task.scheduledAt?.trim().isNotEmpty ?? false) meta.add(task.scheduledAt!.trim());
    if (task.cwd?.trim().isNotEmpty ?? false) meta.add(task.cwd!.trim());
    if (task.pid != null) meta.add('PID ${task.pid}');

    return Card(
      color: const Color(0xFF111827),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: color.withOpacity(0.25)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(_statusIcon(task.status), color: color, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    task.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: color.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: color.withOpacity(0.35)),
                  ),
                  child: Text(
                    task.status,
                    style: TextStyle(color: color, fontSize: 11),
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: 'Task actions',
                  onSelected: (value) {
                    if (value == 'cancel') onCancel();
                    if (value == 'delete') onDelete();
                  },
                  itemBuilder: (context) => [
                    PopupMenuItem(
                      value: 'cancel',
                      enabled: !task.isTerminalState,
                      child: const Text('Cancel'),
                    ),
                    const PopupMenuItem(
                      value: 'delete',
                      child: Text('Delete'),
                    ),
                  ],
                ),
              ],
            ),
            if (task.detail.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                task.detail,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70),
              ),
            ],
            if (task.command?.trim().isNotEmpty ?? false) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: Colors.black.withOpacity(0.35),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppPalette.border),
                ),
                child: Text(
                  task.command!.trim(),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Colors.white70,
                        fontFamily: 'monospace',
                      ),
                ),
              ),
            ],
            if (meta.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                meta.join(' · '),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(color: AppPalette.accent),
              ),
            ],
            if (task.logPath?.trim().isNotEmpty ?? false) ...[
              const SizedBox(height: 6),
              Text(
                'Log: ${task.logPath}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Colors.white54),
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: onOpen,
                    icon: const Icon(Icons.chat_bubble_outline, size: 16),
                    label: const Text('Agent'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: task.isRunning || task.isTerminalState ? null : onStart,
                    icon: const Icon(Icons.play_arrow, size: 16),
                    label: Text(task.hasLaunchCommand ? 'Launch' : 'Start'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Color _statusColor(String status) {
    final s = status.toLowerCase();
    if (s.contains('complete') || s.contains('done') || s.contains('success')) {
      return Colors.greenAccent;
    }
    if (s.contains('running') || s.contains('progress')) {
      return Colors.orangeAccent;
    }
    if (s.contains('scheduled')) {
      return Colors.purpleAccent;
    }
    if (s.contains('pending') || s.contains('wait') || s.contains('queue')) {
      return AppPalette.accent;
    }
    if (s.contains('cancel')) {
      return Colors.grey;
    }
    if (s.contains('error') || s.contains('fail')) {
      return Colors.redAccent;
    }
    return Colors.grey;
  }

  IconData _statusIcon(String status) {
    final s = status.toLowerCase();
    if (s.contains('complete') || s.contains('done') || s.contains('success')) {
      return Icons.check_circle;
    }
    if (s.contains('running') || s.contains('progress')) {
      return Icons.sync;
    }
    if (s.contains('scheduled')) {
      return Icons.event;
    }
    if (s.contains('pending') || s.contains('wait') || s.contains('queue')) {
      return Icons.schedule;
    }
    if (s.contains('cancel')) {
      return Icons.cancel;
    }
    if (s.contains('error') || s.contains('fail')) {
      return Icons.error;
    }
    return Icons.help_outline;
  }
}

class _TaskQueueDialog extends StatefulWidget {
  final String defaultCwd;
  final List<GpuMetric> gpus;

  const _TaskQueueDialog({
    required this.defaultCwd,
    required this.gpus,
  });

  @override
  State<_TaskQueueDialog> createState() => _TaskQueueDialogState();
}

class _TaskQueueDialogState extends State<_TaskQueueDialog> {
  late final TextEditingController titleController;
  late final TextEditingController commandController;
  late final TextEditingController cwdController;
  late final TextEditingController scheduledAtController;
  late final TextEditingController maxMemoryController;
  late final TextEditingController maxUtilController;
  late final TextEditingController idleMinutesController;

  String launchMode = 'manual';
  int targetGpuIndex = -1;

  @override
  void initState() {
    super.initState();
    titleController = TextEditingController();
    commandController = TextEditingController();
    cwdController = TextEditingController(text: widget.defaultCwd.trim().isEmpty ? '~' : widget.defaultCwd.trim());
    final defaultSchedule = DateTime.now().add(const Duration(hours: 1));
    scheduledAtController = TextEditingController(text: _formatDateTime(defaultSchedule));
    maxMemoryController = TextEditingController(text: '1500');
    maxUtilController = TextEditingController(text: '10');
    idleMinutesController = TextEditingController(text: '5');
  }

  @override
  void dispose() {
    titleController.dispose();
    commandController.dispose();
    cwdController.dispose();
    scheduledAtController.dispose();
    maxMemoryController.dispose();
    maxUtilController.dispose();
    idleMinutesController.dispose();
    super.dispose();
  }

  String _formatDateTime(DateTime value) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${value.year}-${two(value.month)}-${two(value.day)} ${two(value.hour)}:${two(value.minute)}';
  }

  int? _parseInt(TextEditingController controller) {
    final text = controller.text.trim();
    if (text.isEmpty) return null;
    return int.tryParse(text);
  }

  String _statusForMode() {
    switch (launchMode) {
      case 'scheduled':
        return 'scheduled';
      case 'wait_for_idle':
        return 'waiting_gpu';
      case 'manual':
      default:
        return 'queued';
    }
  }

  void _submit() {
    final command = commandController.text.trim();
    if (command.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Command is required.')),
      );
      return;
    }

    final title = titleController.text.trim().isEmpty
        ? command.split(RegExp(r'\s+')).take(4).join(' ')
        : titleController.text.trim();

    final task = TaskItem(
      id: 'task_${DateTime.now().microsecondsSinceEpoch}',
      title: title,
      status: _statusForMode(),
      detail: launchMode == 'manual'
          ? 'Manual launch task.'
          : launchMode == 'scheduled'
              ? 'Scheduled for ${scheduledAtController.text.trim()}.'
              : 'Waiting for an idle GPU according to the resource rule.',
      kind: 'training_job',
      launchMode: launchMode,
      command: command,
      cwd: cwdController.text.trim().isEmpty ? '~' : cwdController.text.trim(),
      scheduledAt: launchMode == 'scheduled' ? scheduledAtController.text.trim() : null,
      createdAt: DateTime.now().toIso8601String(),
      targetGpuIndex: targetGpuIndex >= 0 ? targetGpuIndex : null,
      maxGpuMemoryMb: launchMode == 'wait_for_idle' ? _parseInt(maxMemoryController) : null,
      maxGpuUtilization: launchMode == 'wait_for_idle' ? _parseInt(maxUtilController) : null,
      requiredIdleSeconds: launchMode == 'wait_for_idle' ? ((_parseInt(idleMinutesController) ?? 5) * 60) : null,
    );

    Navigator.pop(context, task);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New DL task'),
      content: SizedBox(
        width: 620,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: titleController,
                decoration: const InputDecoration(
                  labelText: 'Title',
                  hintText: 'e.g. Train normB ablation',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: commandController,
                minLines: 3,
                maxLines: 6,
                style: const TextStyle(fontFamily: 'monospace'),
                decoration: const InputDecoration(
                  labelText: 'Command',
                  hintText: 'python train.py --config configs/exp.yaml',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: cwdController,
                decoration: const InputDecoration(
                  labelText: 'Working directory',
                  hintText: '~/project',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                value: launchMode,
                decoration: const InputDecoration(
                  labelText: 'Launch mode',
                  border: OutlineInputBorder(),
                ),
                items: const [
                  DropdownMenuItem(value: 'manual', child: Text('Manual launch')),
                  DropdownMenuItem(value: 'wait_for_idle', child: Text('Wait for idle GPU')),
                  DropdownMenuItem(value: 'scheduled', child: Text('Scheduled launch')),
                ],
                onChanged: (value) {
                  if (value == null) return;
                  setState(() => launchMode = value);
                },
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<int>(
                value: targetGpuIndex,
                decoration: const InputDecoration(
                  labelText: 'Target GPU',
                  border: OutlineInputBorder(),
                ),
                items: [
                  const DropdownMenuItem<int>(value: -1, child: Text('Auto / any GPU')),
                  for (final gpu in widget.gpus)
                    DropdownMenuItem<int>(
                      value: gpu.index,
                      child: Text('GPU ${gpu.index} · ${gpu.name} · ${gpu.memoryUsedMb.toStringAsFixed(0)}/${gpu.memoryTotalMb.toStringAsFixed(0)} MB'),
                    ),
                ],
                onChanged: (value) => setState(() => targetGpuIndex = value ?? -1),
              ),
              if (launchMode == 'scheduled') ...[
                const SizedBox(height: 12),
                TextField(
                  controller: scheduledAtController,
                  decoration: const InputDecoration(
                    labelText: 'Run at',
                    hintText: 'YYYY-MM-DD HH:mm',
                    border: OutlineInputBorder(),
                  ),
                ),
              ],
              if (launchMode == 'wait_for_idle') ...[
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: maxMemoryController,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Max used memory MB',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: maxUtilController,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Max util %',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: idleMinutesController,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Idle minutes',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  'The task starts only after the selected GPU stays under these limits for the configured idle duration.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white54),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _submit,
          icon: const Icon(Icons.add_task),
          label: const Text('Queue task'),
        ),
      ],
    );
  }
}

class _AgentToolbar extends StatelessWidget {
  final String agentName;
  final bool isStarting;
  final bool isReady;
  final bool isStreaming;
  final VoidCallback onStart;
  final VoidCallback onStop;
  final VoidCallback onClear;

  const _AgentToolbar({
    required this.agentName,
    required this.isStarting,
    required this.isReady,
    required this.isStreaming,
    required this.onStart,
    required this.onStop,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    final status = isStarting
        ? 'Starting'
        : isStreaming
            ? 'Streaming'
            : isReady
                ? 'Ready'
                : 'Stopped';

    final color = isStarting
        ? Colors.orangeAccent
        : isReady
            ? Colors.greenAccent
            : Colors.redAccent;

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          Chip(
            avatar: const Icon(Icons.smart_toy, size: 18),
            label: Text(agentName),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            onPressed: isStarting ? null : onStart,
            icon: isStarting
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.play_arrow),
            label: Text(isReady ? 'Restart' : 'Start'),
          ),
          const SizedBox(width: 8),
          OutlinedButton.icon(
            onPressed: isReady ? onStop : null,
            icon: const Icon(Icons.stop),
            label: const Text('Stop'),
          ),
          const SizedBox(width: 8),
          OutlinedButton.icon(
            onPressed: onClear,
            icon: const Icon(Icons.clear_all),
            label: const Text('Clear'),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: color.withOpacity(0.14),
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: color.withOpacity(0.4)),
            ),
            child: Text(status, style: TextStyle(color: color)),
          ),
        ],
      ),
    );
  }
}

class AgentSuggestionPanel extends StatelessWidget {
  final List<AgentSuggestion> suggestions;
  final ValueChanged<AgentSuggestion> onTap;

  const AgentSuggestionPanel({
    super.key,
    required this.suggestions,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxHeight: 240),
      margin: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppPalette.border),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        itemCount: suggestions.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final item = suggestions[index];
          return ListTile(
            dense: true,
            leading: const Icon(Icons.shortcut),
            title: Text(item.label),
            subtitle: item.description.isEmpty ? null : Text(item.description),
            onTap: () => onTap(item),
          );
        },
      ),
    );
  }
}

class AgentChoicePanel extends StatelessWidget {
  final List<AgentChoice> choices;
  final ValueChanged<AgentChoice> onTap;

  const AgentChoicePanel({
    super.key,
    required this.choices,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxHeight: 260),
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFF0F172A),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppPalette.accent.withOpacity(0.25)),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        itemCount: choices.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final item = choices[index];
          return ListTile(
            dense: true,
            leading: const Icon(Icons.touch_app),
            title: Text(item.label),
            subtitle: item.description.isEmpty ? null : Text(item.description),
            onTap: () => onTap(item),
          );
        },
      ),
    );
  }
}

class AgentMessageBlock extends StatelessWidget {
  final AgentMessage message;
  final String agentName;

  const AgentMessageBlock({
    super.key,
    required this.message,
    required this.agentName,
  });

  @override
  Widget build(BuildContext context) {
    if (message.role == 'system') {
      return Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: AppPalette.border,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(message.text, style: Theme.of(context).textTheme.bodySmall),
      );
    }

    final isUser = message.role == 'user';
    final title = isUser ? 'You' : agentName;
    final color = isUser ? AppPalette.accent : Colors.greenAccent;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isUser ? AppPalette.accent.withOpacity(0.14) : AppPalette.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: isUser ? AppPalette.accent.withOpacity(0.35) : AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(fontWeight: FontWeight.bold, color: color),
          ),
          const SizedBox(height: 8),
          SelectableText(message.text),
        ],
      ),
    );
  }
}


