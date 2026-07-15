part of cozypad;

/* =========================================================
   Commands Tab: visible interactive PTY terminal
========================================================= */


class _CommandWorkspace {
  final String id;
  String title;
  String pwd;
  final TextEditingController pwdController;

  // Keyboard/IME bridge: automatic composing-safe input connection for desktop/mobile IME.
  // TerminalView is still the visible terminal; this controller is never shown
  // as a command box.
  final TextEditingController imeController = TextEditingController();
  final FocusNode keyboardFocusNode = FocusNode(debugLabel: 'commands-terminal-keyboard');
  final FocusNode terminalViewFocusNode = FocusNode(
    debugLabel: 'commands-terminal-view-readonly',
    canRequestFocus: false,
  );
  bool suppressImeChange = false;
  bool imeComposing = false;
  int lastImeCompositionMs = 0;
  Timer? imeFlushTimer;

  late final Terminal terminal;
  late final TerminalController controller;
  SSHSession? session;
  StreamSubscription<Uint8List>? stdoutSub;
  StreamSubscription<Uint8List>? stderrSub;
  bool connecting = false;
  bool connected = false;

  _CommandWorkspace({required this.id, required this.title, this.pwd = '~'})
      : pwdController = TextEditingController(text: pwd);

  Future<void> dispose() async {
    await stdoutSub?.cancel();
    await stderrSub?.cancel();
    session?.close();
    pwdController.dispose();
    imeController.dispose();
    imeFlushTimer?.cancel();
    terminalViewFocusNode.dispose();
    keyboardFocusNode.dispose();
    controller.dispose();
  }
}

class CommandsTab extends StatefulWidget {
  final bool isActive;

  const CommandsTab({super.key, this.isActive = true});

  @override
  State<CommandsTab> createState() => _CommandsTabState();
}

class _CommandsTabState extends State<CommandsTab> with AutomaticKeepAliveClientMixin<CommandsTab> {
  final List<_CommandWorkspace> workspaces = [];
  int selectedIndex = 0;
  int counter = 0;
  Offset? _pointerDownPos;

  _CommandWorkspace get current => workspaces[selectedIndex];

  @override
  void initState() {
    super.initState();
    RawKeyboard.instance.addListener(_handleRawKeyEvent);
    addTerminalPage(autoStart: true);
  }

  @override
  void didUpdateWidget(covariant CommandsTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isActive && !oldWidget.isActive && workspaces.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) focusTerminal(current);
      });
    }
  }

  @override
  void dispose() {
    RawKeyboard.instance.removeListener(_handleRawKeyEvent);
    for (final workspace in workspaces) {
      workspace.dispose();
    }
    super.dispose();
  }

  @override
  bool get wantKeepAlive => true;

  String _quoteShellArg(String value) {
    return "'${value.replaceAll("'", "'\"'\"'")}'";
  }

  void addTerminalPage({bool autoStart = false}) {
    final id = DateTime.now().microsecondsSinceEpoch.toString();
    counter += 1;
    final initialPwd = context.read<SSHProvider>().sharedPwd;
    final workspace = _CommandWorkspace(
      id: id,
      title: 'Terminal $counter',
      pwd: initialPwd,
    );

    workspace.terminal = Terminal(
      maxLines: 10000,
      platform: currentTerminalTargetPlatform(),
      onOutput: (data) {
        // Keep this path for platforms where TerminalView native keyboard input
        // works. The hidden IME bridge below covers Windows/desktop cases where
        // TerminalView focus does not reliably receive text input.
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
    workspace.controller = TerminalController();
    workspace.controller.addListener(() {
      if (mounted) setState(() {});
    });

    workspace.imeController.addListener(() => _flushCommittedImeText(workspace));
    workspace.keyboardFocusNode.addListener(() {
      if (mounted) setState(() {});
    });

    setState(() {
      workspaces.add(workspace);
      selectedIndex = workspaces.length - 1;
    });

    if (autoStart) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        startShell(workspace);
        focusTerminal(workspace);
      });
    }
  }

  Future<void> closeCurrentPage() async {
    if (workspaces.length <= 1) return;
    final removed = workspaces.removeAt(selectedIndex);
    await removed.dispose();
    setState(() {
      selectedIndex = selectedIndex.clamp(0, workspaces.length - 1).toInt();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => focusTerminal(current));
  }

  Future<void> startShell(_CommandWorkspace workspace) async {
    if (workspace.connecting || workspace.connected) return;

    final provider = context.read<SSHProvider>();
    final client = provider.client;

    if (client == null || client.isClosed) {
      workspace.terminal.write('\r\n[SSH is not connected]\r\n');
      return;
    }

    setState(() {
      workspace.connecting = true;
    });

    workspace.terminal.write('\r\n[Starting interactive PTY shell...]\r\n');

    try {
      final width = workspace.terminal.viewWidth > 0 ? workspace.terminal.viewWidth : 80;
      final height = workspace.terminal.viewHeight > 0 ? workspace.terminal.viewHeight : 24;

      final shell = await client.shell(
        pty: SSHPtyConfig(
          type: 'xterm-256color',
          width: width,
          height: height,
        ),
      );

      workspace.session = shell;

      workspace.stdoutSub = shell.stdout.listen(
        (data) => workspace.terminal.write(utf8.decode(data, allowMalformed: true)),
        onError: (error) => workspace.terminal.write('\r\n[stdout error: $error]\r\n'),
      );

      workspace.stderrSub = shell.stderr.listen(
        (data) => workspace.terminal.write(utf8.decode(data, allowMalformed: true)),
        onError: (error) => workspace.terminal.write('\r\n[stderr error: $error]\r\n'),
      );

      setState(() {
        workspace.connected = true;
        workspace.connecting = false;
      });

      workspace.terminal.write('\r\n[Interactive PTY shell connected]\r\n');
      applyPwd(workspace, silent: true);
      focusTerminal(workspace);

      shell.done.then((_) {
        if (!mounted) return;
        workspace.terminal.write('\r\n[Shell closed]\r\n');
        setState(() {
          workspace.connected = false;
          workspace.connecting = false;
          workspace.session = null;
        });
      });
    } catch (e) {
      workspace.terminal.write('\r\n[PTY shell failed: $e]\r\n');
      if (!mounted) return;
      setState(() {
        workspace.connecting = false;
        workspace.connected = false;
      });
    }
  }

  Future<void> restartShell(_CommandWorkspace workspace) async {
    await workspace.stdoutSub?.cancel();
    await workspace.stderrSub?.cancel();
    workspace.session?.close();

    workspace.stdoutSub = null;
    workspace.stderrSub = null;
    workspace.session = null;

    setState(() {
      workspace.connected = false;
      workspace.connecting = false;
    });

    workspace.terminal.write('\r\n[Restarting shell...]\r\n');
    await startShell(workspace);
  }

  void sendText(
    _CommandWorkspace workspace,
    String text, {
    bool refocus = true,
  }) {
    final session = workspace.session;
    if (session == null) {
      workspace.terminal.write('\r\n[Shell is not connected]\r\n');
      return;
    }
    session.write(Uint8List.fromList(utf8.encode(text)));
    if (refocus) focusTerminal(workspace);
  }

  void sendCommand(_CommandWorkspace workspace, String command) {
    sendText(workspace, '$command\r');
  }

  void applyPwd(_CommandWorkspace workspace, {bool silent = false}) {
    final nextPwd = workspace.pwdController.text.trim().isEmpty
        ? '~'
        : workspace.pwdController.text.trim();
    workspace.pwd = nextPwd;
    if (!silent) {
      workspace.terminal.write('\r\n[Set PWD: $nextPwd]\r\n');
    }
    
    final String cmd;
    if (nextPwd == '~') {
      cmd = 'cd ~';
    } else if (nextPwd.startsWith('~/')) {
      final sub = nextPwd.substring(2);
      cmd = 'cd ~/${_quoteShellArg(sub)}';
    } else {
      cmd = 'cd ${_quoteShellArg(nextPwd)}';
    }

    if (silent) {
      sendCommand(workspace, '$cmd && clear');
    } else {
      sendCommand(workspace, cmd);
    }
    setState(() {});
  }

  void clearTerminal(_CommandWorkspace workspace) {
    workspace.terminal.eraseDisplay();
    workspace.terminal.setCursor(0, 0);
    focusTerminal(workspace);
  }

  void focusTerminal(_CommandWorkspace workspace) {
    if (!mounted || !workspaces.contains(workspace)) return;

    // Terminal input is intentionally owned by the IME bridge TextField, not by
    // TerminalView.  On Flutter desktop a mouse click can briefly give focus to
    // TerminalView after our pointer handler runs, so request focus now and once
    // more after the current pointer frame has settled.
    FocusScope.of(context).requestFocus(workspace.keyboardFocusNode);
    SystemChannels.textInput.invokeMethod<void>('TextInput.show');

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !workspaces.contains(workspace)) return;
      if (!workspace.keyboardFocusNode.hasFocus) {
        FocusScope.of(context).requestFocus(workspace.keyboardFocusNode);
        SystemChannels.textInput.invokeMethod<void>('TextInput.show');
      }
    });
  }

  Future<void> pasteClipboardToTerminal(_CommandWorkspace workspace) async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    sendText(workspace, _normalizeTerminalNewlines(text));
    focusTerminal(workspace);
  }

  Future<void> copySelectedText(_CommandWorkspace workspace) async {
    final selection = workspace.controller.selection;
    if (selection == null) return;
    final range = selection.normalized;
    final startLine = range.begin.y;
    final endLine = range.end.y;

    final buffer = StringBuffer();
    for (int y = startLine; y <= endLine; y++) {
      if (y < 0 || y >= workspace.terminal.buffer.lines.length) continue;
      final line = workspace.terminal.buffer.lines[y];
      final from = (y == startLine) ? range.begin.x : 0;
      final to = (y == endLine) ? range.end.x : line.length;

      buffer.write(line.getText(from, to));
      if (y < endLine && !line.isWrapped) {
        buffer.write('\n');
      }
    }

    final text = buffer.toString();
    if (text.isNotEmpty) {
      await Clipboard.setData(ClipboardData(text: text));
    }
  }

  void openExternalTerminal() {
    final provider = context.read<SSHProvider>();
    final connection = provider.activeConnection;
    
    if (connection == null || connection.host.isEmpty || connection.username.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('沒有活躍的 SSH 連線，或連線資訊不足，無法開啟外部終端機')),
      );
      return;
    }

    final host = connection.host;
    final port = connection.port;
    final username = connection.username;

    io.Process.run('cmd.exe', [
      '/c',
      'start',
      'ssh',
      '-p',
      '$port',
      '$username@$host',
    ]);
  }

  String _normalizeTerminalNewlines(String text) {
    return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r');
  }

  Duration _autoImeCommitDelay(_CommandWorkspace workspace, String text) {
    final now = DateTime.now().millisecondsSinceEpoch;
    final recentlyComposed = now - workspace.lastImeCompositionMs < 420;
    final likelyCommittedImeText = recentlyComposed || _containsNonAscii(text);

    // Plain ASCII shell input should feel immediate.  CJK/IME commits need a
    // short settle window because several desktop IMEs briefly expose phonetic
    // composing text as non-composing before the final candidate is committed.
    return likelyCommittedImeText
        ? const Duration(milliseconds: 110)
        : const Duration(milliseconds: 12);
  }

  bool _containsNonAscii(String text) {
    for (final rune in text.runes) {
      if (rune > 0x7F) return true;
    }
    return false;
  }

  bool _hasActiveImeComposition(TextEditingValue value) {
    return value.composing.isValid && !value.composing.isCollapsed;
  }

  bool _hasPendingImeInput(_CommandWorkspace workspace) {
    final value = workspace.imeController.value;
    return value.text.isNotEmpty || _hasActiveImeComposition(value) || workspace.imeComposing;
  }

  void _flushCommittedImeText(_CommandWorkspace workspace) {
    if (workspace.suppressImeChange) return;

    final value = workspace.imeController.value;
    final composing = _hasActiveImeComposition(value);

    workspace.imeFlushTimer?.cancel();

    // CJK IMEs produce intermediate composing text such as zhuyin/pinyin/kana.
    // Do not forward that text to the PTY. Wait until Flutter reports a committed
    // value, then send it once.
    if (composing) {
      workspace.imeComposing = true;
      workspace.lastImeCompositionMs = DateTime.now().millisecondsSinceEpoch;
      if (mounted) setState(() {});
      return;
    }

    if (value.text.isEmpty) {
      if (workspace.imeComposing) {
        workspace.imeComposing = false;
        if (mounted) setState(() {});
      }
      return;
    }

    final delay = _autoImeCommitDelay(workspace, value.text);

    workspace.imeFlushTimer = Timer(delay, () => _commitImeText(workspace));
    if (mounted) setState(() {});
  }

  void _commitImeText(_CommandWorkspace workspace) {
    if (workspace.suppressImeChange) return;

    final value = workspace.imeController.value;
    if (_hasActiveImeComposition(value)) {
      workspace.imeComposing = true;
      workspace.lastImeCompositionMs = DateTime.now().millisecondsSinceEpoch;
      if (mounted) setState(() {});
      return;
    }

    final text = value.text;
    if (text.isEmpty) {
      workspace.imeComposing = false;
      if (mounted) setState(() {});
      return;
    }

    if (workspace.connected) {
      sendText(
        workspace,
        _normalizeTerminalNewlines(text),
        refocus: false,
      );
    }

    workspace.suppressImeChange = true;
    workspace.imeController.value = const TextEditingValue();
    workspace.suppressImeChange = false;
    workspace.imeComposing = false;

    if (mounted) setState(() {});
  }

  void _handleRawKeyEvent(RawKeyEvent event) {
    if (!widget.isActive) return;
    if (event is! RawKeyDownEvent) return;
    if (workspaces.isEmpty) return;

    final workspace = current;
    if (!workspace.keyboardFocusNode.hasFocus || !workspace.connected) return;

    final key = event.logicalKey;
    final isCtrlOrMeta = event.isControlPressed || event.isMetaPressed;
    final imeHasPendingInput = _hasPendingImeInput(workspace);

    if (!isCtrlOrMeta && imeHasPendingInput && _isImeEditingKey(key)) {
      final imeActuallyComposing =
          _hasActiveImeComposition(workspace.imeController.value);

      // Let the active IME consume candidate navigation, commit, cancel, and
      // composing deletion. Otherwise these keys are also sent to the remote
      // PTY, which corrupts CJK input.
      if (imeActuallyComposing) return;

      // If plain text is waiting in the IME bridge and the user presses a
      // terminal delimiter immediately, flush the pending text first so fast
      // typing like `ls<Enter>` still works.
      final sequence = _escapeSequenceForKey(key);
      if (sequence != null &&
          (key == LogicalKeyboardKey.enter ||
              key == LogicalKeyboardKey.numpadEnter ||
              key == LogicalKeyboardKey.space ||
              key == LogicalKeyboardKey.tab)) {
        workspace.imeFlushTimer?.cancel();
        _commitImeText(workspace);
        sendText(workspace, sequence);
      }

      return;
    }

    if (isCtrlOrMeta && event.isShiftPressed && key == LogicalKeyboardKey.keyV) {
      pasteClipboardToTerminal(workspace);
      return;
    }

    if (isCtrlOrMeta && event.isShiftPressed && key == LogicalKeyboardKey.keyC) {
      copySelectedText(workspace);
      return;
    }

    if (isCtrlOrMeta && key == LogicalKeyboardKey.keyC) {
      if (workspace.controller.selection != null) {
        copySelectedText(workspace);
        return;
      }
    }

    if (isCtrlOrMeta) {
      final control = _controlSequenceForKey(key);
      if (control != null) {
        sendText(workspace, control);
      }
      return;
    }

    final sequence = _escapeSequenceForKey(key);
    if (sequence != null) {
      sendText(workspace, sequence);
    }
  }

  bool _isImeEditingKey(LogicalKeyboardKey key) {
    return key == LogicalKeyboardKey.backspace ||
        key == LogicalKeyboardKey.delete ||
        key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter ||
        key == LogicalKeyboardKey.arrowUp ||
        key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.arrowLeft ||
        key == LogicalKeyboardKey.arrowRight ||
        key == LogicalKeyboardKey.home ||
        key == LogicalKeyboardKey.end ||
        key == LogicalKeyboardKey.pageUp ||
        key == LogicalKeyboardKey.pageDown ||
        key == LogicalKeyboardKey.escape ||
        key == LogicalKeyboardKey.space ||
        key == LogicalKeyboardKey.tab;
  }

  String? _controlSequenceForKey(LogicalKeyboardKey key) {
    if (key == LogicalKeyboardKey.keyA) return String.fromCharCode(1);
    if (key == LogicalKeyboardKey.keyB) return String.fromCharCode(2);
    if (key == LogicalKeyboardKey.keyC) return String.fromCharCode(3);
    if (key == LogicalKeyboardKey.keyD) return String.fromCharCode(4);
    if (key == LogicalKeyboardKey.keyE) return String.fromCharCode(5);
    if (key == LogicalKeyboardKey.keyF) return String.fromCharCode(6);
    if (key == LogicalKeyboardKey.keyG) return String.fromCharCode(7);
    if (key == LogicalKeyboardKey.keyH) return String.fromCharCode(8);
    if (key == LogicalKeyboardKey.keyI) return String.fromCharCode(9);
    if (key == LogicalKeyboardKey.keyJ) return String.fromCharCode(10);
    if (key == LogicalKeyboardKey.keyK) return String.fromCharCode(11);
    if (key == LogicalKeyboardKey.keyL) return String.fromCharCode(12);
    if (key == LogicalKeyboardKey.keyM) return String.fromCharCode(13);
    if (key == LogicalKeyboardKey.keyN) return String.fromCharCode(14);
    if (key == LogicalKeyboardKey.keyO) return String.fromCharCode(15);
    if (key == LogicalKeyboardKey.keyP) return String.fromCharCode(16);
    if (key == LogicalKeyboardKey.keyQ) return String.fromCharCode(17);
    if (key == LogicalKeyboardKey.keyR) return String.fromCharCode(18);
    if (key == LogicalKeyboardKey.keyS) return String.fromCharCode(19);
    if (key == LogicalKeyboardKey.keyT) return String.fromCharCode(20);
    if (key == LogicalKeyboardKey.keyU) return String.fromCharCode(21);
    // Do not intercept Ctrl+V without Shift; the hidden IME TextField uses it
    // for paste and then forwards the pasted text to the terminal.
    if (key == LogicalKeyboardKey.keyW) return String.fromCharCode(23);
    if (key == LogicalKeyboardKey.keyX) return String.fromCharCode(24);
    if (key == LogicalKeyboardKey.keyY) return String.fromCharCode(25);
    if (key == LogicalKeyboardKey.keyZ) return String.fromCharCode(26);
    if (key == LogicalKeyboardKey.bracketLeft) return String.fromCharCode(27);
    if (key == LogicalKeyboardKey.backslash) return String.fromCharCode(28);
    if (key == LogicalKeyboardKey.bracketRight) return String.fromCharCode(29);
    if (key == LogicalKeyboardKey.digit6) return String.fromCharCode(30);
    if (key == LogicalKeyboardKey.minus) return String.fromCharCode(31);
    return null;
  }

  String? _escapeSequenceForKey(LogicalKeyboardKey key) {
    if (key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter) return '\r';
    if (key == LogicalKeyboardKey.backspace) return '\x7f';
    if (key == LogicalKeyboardKey.tab) return '\t';
    if (key == LogicalKeyboardKey.escape) return '\x1b';
    if (key == LogicalKeyboardKey.arrowUp) return '\x1b[A';
    if (key == LogicalKeyboardKey.arrowDown) return '\x1b[B';
    if (key == LogicalKeyboardKey.arrowRight) return '\x1b[C';
    if (key == LogicalKeyboardKey.arrowLeft) return '\x1b[D';
    if (key == LogicalKeyboardKey.insert) return '\x1b[2~';
    if (key == LogicalKeyboardKey.delete) return '\x1b[3~';
    if (key == LogicalKeyboardKey.home) return '\x1b[H';
    if (key == LogicalKeyboardKey.end) return '\x1b[F';
    if (key == LogicalKeyboardKey.pageUp) return '\x1b[5~';
    if (key == LogicalKeyboardKey.pageDown) return '\x1b[6~';
    if (key == LogicalKeyboardKey.f1) return '\x1bOP';
    if (key == LogicalKeyboardKey.f2) return '\x1bOQ';
    if (key == LogicalKeyboardKey.f3) return '\x1bOR';
    if (key == LogicalKeyboardKey.f4) return '\x1bOS';
    if (key == LogicalKeyboardKey.f5) return '\x1b[15~';
    if (key == LogicalKeyboardKey.f6) return '\x1b[17~';
    if (key == LogicalKeyboardKey.f7) return '\x1b[18~';
    if (key == LogicalKeyboardKey.f8) return '\x1b[19~';
    if (key == LogicalKeyboardKey.f9) return '\x1b[20~';
    if (key == LogicalKeyboardKey.f10) return '\x1b[21~';
    if (key == LogicalKeyboardKey.f11) return '\x1b[23~';
    if (key == LogicalKeyboardKey.f12) return '\x1b[24~';
    return null;
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final workspace = current;
    final statusText = workspace.connecting
        ? 'Connecting PTY...'
        : workspace.connected
            ? 'Interactive PTY connected'
            : 'PTY disconnected';

    return Column(
      children: [
        Container(
          width: double.infinity,
          color: const Color(0xFF111827),
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
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
                        onSelected: (_) {
                          setState(() => selectedIndex = i);
                          WidgetsBinding.instance.addPostFrameCallback((_) => focusTerminal(workspaces[i]));
                        },
                      ),
                      const SizedBox(width: 8),
                    ],
                    ActionChip(
                      avatar: const Icon(Icons.add, size: 18),
                      label: const Text('New Terminal'),
                      onPressed: () => addTerminalPage(autoStart: true),
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
                        labelText: 'PWD',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onSubmitted: (_) => applyPwd(workspace),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonal(
                    onPressed: workspace.connected ? () => applyPwd(workspace) : null,
                    child: const Text('Apply'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    _TerminalStatusChip(
                      connected: workspace.connected,
                      connecting: workspace.connecting,
                      text: statusText,
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonalIcon(
                      onPressed: workspace.connecting ? null : () => restartShell(workspace),
                      icon: const Icon(Icons.restart_alt),
                      label: const Text('Restart'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: workspace.connected ? () => sendCommand(workspace, 'htop') : null,
                      child: const Text('htop'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: workspace.connected ? () => sendCommand(workspace, 'top') : null,
                      child: const Text('top'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: workspace.connected ? () => sendCommand(workspace, 'df -h') : null,
                      child: const Text('df -h'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: workspace.connected ? () => sendCommand(workspace, 'du -h -d 1') : null,
                      child: const Text('du -h -d 1'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: workspace.connected ? () => sendCommand(workspace, 'pwd') : null,
                      child: const Text('pwd'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: workspace.connected ? () => sendText(workspace, '\x03') : null,
                      child: const Text('Interrupt'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: workspace.connected ? () => sendText(workspace, '\x04') : null,
                      child: const Text('Ctrl+D'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: workspace.connected && workspace.controller.selection != null
                          ? () => copySelectedText(workspace)
                          : null,
                      child: const Text('Copy'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: workspace.connected ? () => pasteClipboardToTerminal(workspace) : null,
                      child: const Text('Paste'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: () => clearTerminal(workspace),
                      child: const Text('Clear'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: Listener(
            behavior: HitTestBehavior.opaque,
            onPointerDown: (event) {
              _pointerDownPos = event.localPosition;
            },
            onPointerUp: (event) {
              if (_pointerDownPos != null) {
                final distance = (event.localPosition - _pointerDownPos!).distance;
                if (distance < 5.0) {
                  focusTerminal(workspace);
                  Future<void>.delayed(const Duration(milliseconds: 40), () {
                    if (!mounted || !workspaces.contains(workspace)) return;
                    focusTerminal(workspace);
                  });
                }
              }
              _pointerDownPos = null;
            },
            child: Container(
              color: AppPalette.backgroundDeep,
              child: Stack(
                children: [
                  TerminalView(
                    workspace.terminal,
                    theme: TerminalTheme(
                      cursor: AppPalette.accent,
                      selection: Color(0x336E8CFF),
                      foreground: AppPalette.textPrimary,
                      background: AppPalette.backgroundDeep,
                      black: Color(0XFF000000),
                      red: Color(0XFFCD3131),
                      green: Color(0XFF0DBC79),
                      yellow: Color(0XFFE5E510),
                      blue: Color(0XFF2472C8),
                      magenta: Color(0XFFBC3FBC),
                      cyan: Color(0XFF11A8CD),
                      white: Color(0XFFE5E5E5),
                      brightBlack: Color(0XFF666666),
                      brightRed: Color(0XFFF14C4C),
                      brightGreen: Color(0XFF23D18B),
                      brightYellow: Color(0XFFF5F543),
                      brightBlue: Color(0XFF3B8EEA),
                      brightMagenta: Color(0XFFD670D6),
                      brightCyan: Color(0XFF29B8DB),
                      brightWhite: Color(0XFFFFFFFF),
                      searchHitBackground: Color(0XFFFFFF2B),
                      searchHitBackgroundCurrent: Color(0XFF31FF26),
                      searchHitForeground: Color(0XFF000000),
                    ),
                    controller: workspace.controller,
                    focusNode: workspace.terminalViewFocusNode,
                    autofocus: false,
                    deleteDetection: true,
                    keyboardType: TextInputType.text,
                    keyboardAppearance: Brightness.dark,
                    cursorType: TerminalCursorType.block,
                    alwaysShowCursor: true,
                    backgroundOpacity: 1,
                    padding: const EdgeInsets.fromLTRB(8, 8, 8, 62),
                    readOnly: true,
                    onSecondaryTapDown: (details, offset) {
                      if (workspace.controller.selection != null) {
                        copySelectedText(workspace);
                      } else {
                        pasteClipboardToTerminal(workspace);
                      }
                    },
                  ),
                  Positioned(
                    left: 12,
                    right: 12,
                    bottom: 10,
                    child: _TerminalImeBridge(
                      controller: workspace.imeController,
                      focusNode: workspace.keyboardFocusNode,
                      connected: workspace.connected,
                      composing: workspace.imeComposing,
                      focused: workspace.keyboardFocusNode.hasFocus,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _TerminalImeBridge extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool connected;
  final bool composing;
  final bool focused;

  const _TerminalImeBridge({
    required this.controller,
    required this.focusNode,
    required this.connected,
    required this.composing,
    required this.focused,
  });

  @override
  Widget build(BuildContext context) {
    final borderColor = focused
        ? AppPalette.accent.withValues(alpha: 0.65)
        : Colors.white.withValues(alpha: 0.18);
    final iconColor = connected
        ? (focused ? AppPalette.accent : Colors.white70)
        : Colors.redAccent;

    return Material(
      color: Colors.transparent,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.surface.withValues(alpha: 0.95),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: borderColor),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.45),
              blurRadius: 14,
              offset: const Offset(0, 5),
            ),
          ],
        ),
        child: SizedBox(
          height: 46,
          child: Row(
            children: [
              const SizedBox(width: 10),
              Icon(Icons.keyboard, size: 18, color: iconColor),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  autofocus: true,
                  enabled: connected,
                  keyboardType: TextInputType.text,
                  textInputAction: TextInputAction.none,
                  autocorrect: false,
                  enableSuggestions: false,
                  enableInteractiveSelection: false,
                  showCursor: true,
                  maxLines: 1,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 15,
                    height: 1.2,
                    color: Colors.white,
                  ),
                  cursorColor: AppPalette.accent,
                  decoration: InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    hintText: connected
                        ? (composing
                            ? '輸入法組字中；選字完成後會自動送進終端機'
                            : '鍵盤捕捉列：直接打字，內容會即時送入終端機')
                        : 'PTY 尚未連線',
                    hintStyle: TextStyle(
                      color: composing
                          ? AppPalette.accent.withValues(alpha: 0.72)
                          : Colors.white.withValues(alpha: 0.46),
                    ),
                    contentPadding: const EdgeInsets.symmetric(vertical: 13),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              AnimatedOpacity(
                opacity: focused ? 0.0 : 1.0,
                duration: const Duration(milliseconds: 120),
                child: Text(
                  'click to type',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Colors.white54,
                      ),
                ),
              ),
              const SizedBox(width: 12),
            ],
          ),
        ),
      ),
    );
  }
}






