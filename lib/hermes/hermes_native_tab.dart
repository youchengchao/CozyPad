part of cozypad;

class HermesNativeTab extends StatefulWidget {
  const HermesNativeTab({super.key});

  @override
  State<HermesNativeTab> createState() => _HermesNativeTabState();
}

class _HermesNativeTabState extends State<HermesNativeTab>
    with AutomaticKeepAliveClientMixin<HermesNativeTab> {
  static const _legacyHermesSettingsKey = 'ssh_dashboard_hermes_settings_v2';
  static const _hermesApiKeyKey = 'ssh_dashboard_hermes_google_api_key_v1';
  static const _secureStorage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );
  static const String _defaultGoogleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  static const String _defaultGoogleModel = 'gemini-3.5-flash';

  static const List<Map<String, String>> _slashCommands = [
    {'cmd': '/clear', 'desc': 'Start a new blank chat session'},
    {'cmd': '/skills', 'desc': 'Navigate to Skills Hub'},
    {'cmd': '/memory', 'desc': 'Navigate to SOUL Persona'},
    {'cmd': '/tasks', 'desc': 'Navigate to Tasks Kanban'},
    {'cmd': '/settings', 'desc': 'Open System Settings'},
    {'cmd': '/resume', 'desc': 'Select a past session from sidebar'},
    {'cmd': '/help', 'desc': 'Show all commands and guides'},
  ];

  final TextEditingController inputController = TextEditingController();
  final TextEditingController modelController = TextEditingController(text: _defaultGoogleModel);
  final TextEditingController baseUrlController = TextEditingController(text: _defaultGoogleBaseUrl);
  final TextEditingController apiKeyController = TextEditingController();
  final TextEditingController hermesHomeController = TextEditingController();
  final TextEditingController soulController = TextEditingController();
  final TextEditingController profileController = TextEditingController(text: 'default');
  final TextEditingController projectController = TextEditingController(text: 'general');
  final ScrollController chatScrollController = ScrollController();
  final ScrollController sidebarChatsScrollController = ScrollController();
  final FocusNode inputFocusNode = FocusNode(debugLabel: 'Hermes chat input');

  late HermesSessionStore sessionStore;
  late HermesMemoryStore memoryStore;
  late final HermesSyncManager syncManager;
  final HermesLlmClient llmClient = HermesLlmClient();
  final HermesToolGateway toolGateway = HermesToolGateway();
  final HermesApprovalPolicy approvalPolicy = HermesApprovalPolicy();
  final HermesPromptBuilder promptBuilder = HermesPromptBuilder();

  _HermesStudioSection section = _HermesStudioSection.overview;
  bool settingsLoaded = false;
  bool hideSecrets = true;
  bool chatRequestRunning = false;
  bool allowRemoteTools = true;
  bool requireApprovalDestructive = true;
  bool requireApprovalGpuPreempt = true;
  bool requireApprovalMultiGpu = true;
  String lastStatus = 'Dashboard-native Hermes engine is idle.';
  String _turnPhase = '';
  DateTime? _turnStartTime;
  Timer? _turnElapsedTimer;
  List<HermesMessage> visibleMessages = [];
  List<HermesApiProfile> apiProfiles = [];
  String activeApiProfileId = 'default';
  String _activeMemoryFile = 'soul'; // 'soul', 'project_memory', 'general_memory', 'user_profile', or 'kb/filename.md'
  List<io.File> _kbFiles = [];
  final TextEditingController _kbFileContentController = TextEditingController();
  String? _selectedKbFileName;

  final Map<String, String> profileApiKeys = {};

  List<HermesSession> _sessionsList = [];
  bool _loadingSessions = false;
  List<io.File> _localSkills = [];
  bool _loadingSkills = false;
  bool _rightPanelExpanded = true;
  int _rightPanelTabIndex = 0; // 0: Console, 1: Memory, 2: GPU, 3: Tasks
  List<String> _liveTraceLogs = [];
  int? _selectedConsoleStepIndex;

  final List<String> _inputHistory = [];
  int _historyIndex = -1;
  String _composerDraft = '';
  int _selectedSuggestionIndex = 0;
  int _selectedChoiceIndex = -1;

  static const List<_HermesFeatureSpec> featureSpecs = [
    _HermesFeatureSpec(
      title: 'Dart-native Hermes harness MVP',
      description: 'Chat now goes through a dashboard-native HermesHarness: runtime frame, tool registry, approval policy, memory, session persistence, and model continuation are owned by the app, not by a persona prompt.',
      icon: Icons.hub,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Universal LLM client',
      description: 'Unified generate content calls supporting both Google AI Studio and OpenAI/Ollama endpoints are isolated in HermesLlmClient.',
      icon: Icons.cloud,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Event stream',
      description: 'Turns emit user, tool-call, tool-result, assistant, completion, and error events so the chat is no longer plain text only.',
      icon: Icons.stream,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Dashboard tool gateway',
      description: 'Read-only dashboard.context, gpu.snapshot, task.list, file.list, file.read_text, and ssh.run_readonly adapters are registered.',
      icon: Icons.router,
      status: 'partial',
    ),
    _HermesFeatureSpec(
      title: 'Session persistence',
      description: 'The active Hermes session is stored as JSON under hermes_home, separated by profile and project.',
      icon: Icons.save,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Secret boundary',
      description: 'Google AI Studio API key is stored as a separate secure-storage secret; non-secret model/workspace settings are stored in local JSON without apiKey.',
      icon: Icons.lock,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Claude Code style chat UX',
      description: 'Tool event cards are emitted by the harness event stream and collapsed by default; clarification requests render as actionable follow-up cards instead of buried plain text.',
      icon: Icons.question_answer,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Hermes memory system',
      description: 'MEMORY.md and USER.md stores are implemented with Hermes-style add/replace/remove semantics, bounded char limits, section delimiters, duplicate prevention, and prompt snapshots.',
      icon: Icons.psychology_alt,
      status: 'implemented',
    ),
    _HermesFeatureSpec(
      title: 'Skills / automations',
      description: 'These surfaces remain next milestones; memory and tools now have priority over skill marketplace or scheduler work.',
      icon: Icons.construction,
      status: 'next',
    ),
  ];

  bool _wasConnected = false;

  @override
  void initState() {
    super.initState();
    hermesHomeController.text = _defaultHermesHome();
    soulController.text = 'You are Hermes inside SSH Dashboard: a cautious deep-learning operations assistant that monitors GPU resources, records mistakes, and asks for approval before risky actions.';
    sessionStore = HermesSessionStore(homePath: hermesHomeController.text);
    memoryStore = HermesMemoryStore(homePath: hermesHomeController.text);
    syncManager = HermesSyncManager(sessionStore: sessionStore, memoryStore: memoryStore);

    final dashboard = context.read<SSHProvider>();
    dashboard.addListener(_onConnectionChanged);
    _wasConnected = dashboard.isConnected;

    inputFocusNode.onKeyEvent = (node, event) {
      if (event is KeyDownEvent || event is KeyRepeatEvent) {
        final isCtrl = HardwareKeyboard.instance.isControlPressed;
        final isShift = HardwareKeyboard.instance.isShiftPressed;

        if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
          final handled = _handleArrowUp(isCtrl || isShift);
          return handled ? KeyEventResult.handled : KeyEventResult.ignored;
        } else if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
          final handled = _handleArrowDown(isCtrl || isShift);
          return handled ? KeyEventResult.handled : KeyEventResult.ignored;
        } else if (event.logicalKey == LogicalKeyboardKey.enter && !isShift) {
          final handled = _handleEnter();
          return handled ? KeyEventResult.handled : KeyEventResult.ignored;
        } else if (event.logicalKey == LogicalKeyboardKey.keyV && isCtrl) {
          Clipboard.getData(Clipboard.kTextPlain).then((data) {
            if (data == null || data.text == null || data.text!.trim().isEmpty) {
              unawaited(_pasteImage());
            }
          });
        }
      }
      return KeyEventResult.ignored;
    };

    unawaited(_loadHermesSettings());
  }

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    context.read<SSHProvider>().removeListener(_onConnectionChanged);
    inputController.dispose();
    modelController.dispose();
    baseUrlController.dispose();
    apiKeyController.dispose();
    hermesHomeController.dispose();
    soulController.dispose();
    _kbFileContentController.dispose();
    profileController.dispose();
    projectController.dispose();
    chatScrollController.dispose();
    sidebarChatsScrollController.dispose();
    inputFocusNode.dispose();
    _turnElapsedTimer?.cancel();
    super.dispose();
  }

  ProjectProfile? _lastActiveProject;
  String? _lastConnectedHost;

  void _onConnectionChanged() {
    final dashboard = context.read<SSHProvider>();

    bool projectChanged = dashboard.activeProject != _lastActiveProject;
    bool hostChanged = dashboard.connectedHost != _lastConnectedHost;

    if (projectChanged) {
      _lastActiveProject = dashboard.activeProject;
      if (dashboard.activeProject != null) {
        projectController.text = dashboard.activeProject!.id;
        profileController.text = 'default';
      }
    }

    if (projectChanged || hostChanged) {
      _lastConnectedHost = dashboard.connectedHost;
      unawaited(_saveAndReloadForActiveProject(dashboard));
    }

    if (dashboard.isConnected && !_wasConnected) {
      _wasConnected = true;
      unawaited(_syncFromRemoteAndReload(dashboard));
    } else if (!dashboard.isConnected) {
      _wasConnected = false;
    }
  }

  Future<void> _saveAndReloadForActiveProject(SSHProvider dashboard) async {
    final settings = _settings();
    sessionStore.homePath = settings.hermesHome;
    memoryStore.homePath = settings.hermesHome;
    memoryStore.profile = settings.profile;
    memoryStore.project = settings.project;
    if (dashboard.isConnected) {
      try {
        await syncManager.syncFromRemote(dashboard);
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
    await sessionStore.load(
      profile: settings.profile,
      project: settings.project,
      connectedHost: dashboard.connectedHost,
      sessionId: 'default',
    );
    if (!mounted) return;
    setState(() {
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      lastStatus = 'Project switched to "${settings.project}". Session and memories loaded.';
    });
    unawaited(_loadSessionsList());
    unawaited(_loadLocalSkills());
    unawaited(_loadKnowledgeBaseFiles());
    _scrollChatSoon();
  }

  Future<void> _syncFromRemoteAndReload(SSHProvider dashboard) async {
    setState(() {
      lastStatus = 'Syncing session and memory from remote server...';
    });
    try {
      await syncManager.syncFromRemote(dashboard);
      await syncManager.syncToRemote(dashboard);
      if (!mounted) return;
      setState(() {
        visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
        lastStatus = 'Session synced from remote server successfully.';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        lastStatus = 'Failed to sync from remote: $e';
      });
    }
  }

  HermesSettings _settings() {
    return HermesSettings(
      model: modelController.text.trim().isEmpty ? _defaultGoogleModel : modelController.text.trim(),
      baseUrl: baseUrlController.text.trim().isEmpty ? _defaultGoogleBaseUrl : baseUrlController.text.trim(),
      apiKey: apiKeyController.text,
      hermesHome: hermesHomeController.text.trim(),
      soul: soulController.text,
      profile: profileController.text.trim().isEmpty ? 'default' : profileController.text.trim(),
      project: projectController.text.trim().isEmpty ? 'general' : projectController.text.trim(),
      allowRemoteTools: allowRemoteTools,
      requireApprovalDestructive: requireApprovalDestructive,
      requireApprovalGpuPreempt: requireApprovalGpuPreempt,
      requireApprovalMultiGpu: requireApprovalMultiGpu,
    );
  }

  Future<void> _loadHermesSettings() async {
    Map<String, dynamic> decoded = <String, dynamic>{};
    Map<String, dynamic> legacyDecoded = <String, dynamic>{};

    try {
      decoded = await _readHermesSettingsFile();
    } catch (_) {
      decoded = <String, dynamic>{};
    }

    final legacyRaw = await _secureStorage.read(key: _legacyHermesSettingsKey);
    if (legacyRaw != null && legacyRaw.trim().isNotEmpty) {
      try {
        final legacy = jsonDecode(legacyRaw);
        if (legacy is Map) legacyDecoded = Map<String, dynamic>.from(legacy);
      } catch (_) {
        legacyDecoded = <String, dynamic>{};
      }
    }

    if (decoded.isEmpty && legacyDecoded.isNotEmpty) {
      decoded = Map<String, dynamic>.from(legacyDecoded)..remove('apiKey');
    }

    hermesHomeController.text = decoded['hermesHome']?.toString() ?? _defaultHermesHome();
    soulController.text = decoded['soul']?.toString() ?? soulController.text;
    profileController.text = decoded['profile']?.toString() ?? 'default';
    projectController.text = decoded['project']?.toString() ?? 'general';
    allowRemoteTools = decoded['allowRemoteTools'] != false;
    requireApprovalDestructive = decoded['requireApprovalDestructive'] != false;
    requireApprovalGpuPreempt = decoded['requireApprovalGpuPreempt'] != false;
    requireApprovalMultiGpu = decoded['requireApprovalMultiGpu'] != false;

    // Load/Migrate API Profiles
    final List<dynamic> profilesJson = decoded['apiProfiles'] ?? [];
    if (profilesJson.isEmpty) {
      apiProfiles = [
        const HermesApiProfile(
          id: 'default',
          name: 'Google AI Studio',
          baseUrl: _defaultGoogleBaseUrl,
          model: _defaultGoogleModel,
          limitLabel: '10 RPM Free / 1M context',
          supportedModels: [
            'gemini-3.5-flash',
            'gemini-3.1-pro-preview',
            'gemma-4-31b-it',
            'gemma-4-26b-a4b-it',
          ],
        ),
        const HermesApiProfile(
          id: 'openai',
          name: 'OpenAI API',
          baseUrl: 'https://api.openai.com/v1',
          model: 'o3',
          limitLabel: '500 RPM / 200k context',
          supportedModels: [
            'o3',
            'o4-mini',
            'gpt-4.1',
            'gpt-4.1-mini',
            'gpt-4.1-nano',
            'gpt-4o',
            'gpt-4o-mini',
          ],
        ),
        const HermesApiProfile(
          id: 'anthropic',
          name: 'Anthropic API',
          baseUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-20250514',
          limitLabel: '50 RPM / 200k context',
          supportedModels: [
            'claude-sonnet-4-20250514',
            'claude-opus-4-20250514',
            'claude-3-7-sonnet-20250219',
            'claude-3-5-haiku-20241022',
          ],
        ),
        const HermesApiProfile(
          id: 'ollama_local',
          name: 'Ollama (Local)',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3:32b',
          limitLabel: 'Unlimited (Local)',
          supportedModels: [
            'qwen3:32b',
            'qwen3:8b',
            'llama3.3:70b',
            'deepseek-r1:32b',
            'gemma3:27b',
            'mistral-large',
            'phi4:14b',
          ],
        ),
        const HermesApiProfile(
          id: 'deepseek',
          name: 'DeepSeek API',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          limitLabel: '60 RPM / 64k context',
          supportedModels: [
            'deepseek-chat',
            'deepseek-reasoner',
          ],
        ),
      ];
    } else {
      apiProfiles = profilesJson.map((e) => HermesApiProfile.fromJson(e)).toList();
      // Migration: fill in supportedModels for profiles saved before this field existed
      const defaultModelsMap = <String, List<String>>{
        'default': ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'],
        'openai': ['o3', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'],
        'openai_gpt4o': ['o3', 'o4-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'],
        'anthropic': ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
        'ollama_local': ['qwen3:32b', 'qwen3:8b', 'llama3.3:70b', 'deepseek-r1:32b', 'gemma3:27b', 'mistral-large', 'phi4:14b'],
        'deepseek': ['deepseek-chat', 'deepseek-reasoner'],
      };
      apiProfiles = apiProfiles.map((p) {
        if (p.supportedModels.isEmpty) {
          final defaults = defaultModelsMap[p.id];
          if (defaults != null) {
            return p.copyWith(supportedModels: defaults);
          }
          // For unknown providers, at least include the current model
          return p.copyWith(supportedModels: [p.model]);
        }
        return p;
      }).toList();
    }
    activeApiProfileId = decoded['activeApiProfileId']?.toString() ?? 'default';

    // Migrate legacy key if exists
    final secureApiKey = await _secureStorage.read(key: _hermesApiKeyKey);
    final legacyApiKey = legacyDecoded['apiKey']?.toString() ?? '';
    final primaryKey = secureApiKey?.trim().isNotEmpty == true ? secureApiKey! : legacyApiKey;
    if (primaryKey.isNotEmpty && secureApiKey == null) {
      await _secureStorage.write(key: _hermesApiKeyKey, value: primaryKey);
    }

    for (final profile in apiProfiles) {
      final key = 'ssh_dashboard_hermes_api_key_${profile.id}';
      var apiKey = await _secureStorage.read(key: key);
      if (profile.id == 'default' && (apiKey == null || apiKey.trim().isEmpty) && primaryKey.isNotEmpty) {
        apiKey = primaryKey;
        await _secureStorage.write(key: key, value: apiKey);
      }
      profileApiKeys[profile.id] = apiKey ?? '';
    }

    final activeProfile = apiProfiles.firstWhere((p) => p.id == activeApiProfileId, orElse: () => apiProfiles.first);
    modelController.text = decoded['model']?.toString() ?? activeProfile.model;
    baseUrlController.text = decoded['baseUrl']?.toString() ?? activeProfile.baseUrl;
    apiKeyController.text = profileApiKeys[activeProfile.id] ?? '';

    if (legacyDecoded.isNotEmpty) {
      await _writeHermesSettingsFile(decoded);
      await _secureStorage.delete(key: _legacyHermesSettingsKey);
    }

    sessionStore = HermesSessionStore(homePath: hermesHomeController.text.trim());
    final settings = _settings();
    memoryStore = HermesMemoryStore(
      homePath: hermesHomeController.text.trim(),
      profile: settings.profile,
      project: settings.project,
    );
    syncManager = HermesSyncManager(sessionStore: sessionStore, memoryStore: memoryStore);
    final dashboard = context.read<SSHProvider>();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncFromRemote(dashboard);
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
    await sessionStore.load(
      profile: _settings().profile,
      project: _settings().project,
      connectedHost: dashboard.connectedHost,
    );

    if (!mounted) return;
    setState(() {
      settingsLoaded = true;
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      lastStatus = sessionStore.lastError == null
          ? 'Hermes settings and active session loaded. API key is isolated in secure storage.'
          : 'Settings loaded; session store fallback is active: ${sessionStore.lastError}';
    });
    unawaited(_loadSessionsList());
    unawaited(_loadLocalSkills());
    unawaited(_loadKnowledgeBaseFiles());
    _scrollChatSoon();
  }

  Future<void> _saveHermesSettings() async {
    final settings = _settings();
    final nonSecretSettings = <String, dynamic>{
      'model': settings.model,
      'baseUrl': settings.baseUrl,
      'hermesHome': settings.hermesHome,
      'soul': settings.soul,
      'profile': settings.profile,
      'project': settings.project,
      'allowRemoteTools': allowRemoteTools,
      'requireApprovalDestructive': requireApprovalDestructive,
      'requireApprovalGpuPreempt': requireApprovalGpuPreempt,
      'requireApprovalMultiGpu': requireApprovalMultiGpu,
      'updatedAt': DateTime.now().toIso8601String(),
      'activeApiProfileId': activeApiProfileId,
      'apiProfiles': apiProfiles.map((e) => e.toJson()).toList(),
    };

    await _writeHermesSettingsFile(nonSecretSettings);
    final cleanApiKey = settings.apiKey.trim();
    
    profileApiKeys[activeApiProfileId] = cleanApiKey;
    final secureProfileKey = 'ssh_dashboard_hermes_api_key_$activeApiProfileId';
    if (cleanApiKey.isEmpty) {
      await _secureStorage.delete(key: secureProfileKey);
      if (activeApiProfileId == 'default') {
        await _secureStorage.delete(key: _hermesApiKeyKey);
      }
    } else {
      await _secureStorage.write(key: secureProfileKey, value: cleanApiKey);
      if (activeApiProfileId == 'default') {
        await _secureStorage.write(key: _hermesApiKeyKey, value: cleanApiKey);
      }
    }
    await _secureStorage.delete(key: _legacyHermesSettingsKey);

    sessionStore.homePath = settings.hermesHome;
    memoryStore.homePath = settings.hermesHome;
    memoryStore.profile = settings.profile;
    memoryStore.project = settings.project;
    final dashboard = context.read<SSHProvider>();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
    await sessionStore.load(
      profile: settings.profile,
      project: settings.project,
      connectedHost: dashboard.connectedHost,
      sessionId: sessionStore.activeSession?.id,
    );
    if (!mounted) return;
    setState(() {
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      lastStatus = 'Hermes settings saved. Active API profile: ${apiProfiles.firstWhere((p) => p.id == activeApiProfileId).name}';
    });
    unawaited(_loadKnowledgeBaseFiles());
  }

  Future<void> _resetHermesSettings() async {
    setState(() {
      modelController.text = _defaultGoogleModel;
      baseUrlController.text = _defaultGoogleBaseUrl;
      apiKeyController.clear();
      hermesHomeController.text = _defaultHermesHome();
      soulController.text = 'You are Hermes inside SSH Dashboard: a cautious deep-learning operations assistant that monitors GPU resources, records mistakes, and asks for approval before risky actions.';
      profileController.text = 'default';
      projectController.text = 'general';
      allowRemoteTools = true;
      requireApprovalDestructive = true;
      requireApprovalGpuPreempt = true;
      requireApprovalMultiGpu = true;
      lastStatus = 'Hermes settings reset.';
    });
    await _saveHermesSettings();
  }

  Future<void> _loadKnowledgeBaseFiles() async {
    if (kIsWeb) return;
    try {
      final root = memoryStore._expandedHome(memoryStore.homePath);
      final safeProfile = memoryStore._safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
      final safeProject = memoryStore._safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
      final kbDir = io.Directory('$root/memories/projects/$safeProfile/$safeProject/knowledge');
      if (!await kbDir.exists()) {
        await kbDir.create(recursive: true);
      }
      final files = await kbDir
          .list()
          .where((entity) => entity is io.File && entity.path.toLowerCase().endsWith('.md'))
          .cast<io.File>()
          .toList();
      files.sort((a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()));
      if (mounted) {
        setState(() {
          _kbFiles = files;
        });
      }
    } catch (_) {}
  }

  Future<void> _selectMemoryFile(String fileKey) async {
    setState(() {
      _activeMemoryFile = fileKey;
    });
    if (fileKey.startsWith('kb/')) {
      final fileName = fileKey.substring(3);
      _selectedKbFileName = fileName;
      final root = memoryStore._expandedHome(memoryStore.homePath);
      final safeProfile = memoryStore._safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
      final safeProject = memoryStore._safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
      final file = io.File('$root/memories/projects/$safeProfile/$safeProject/knowledge/$fileName');
      if (await file.exists()) {
        final raw = await file.readAsString();
        _kbFileContentController.text = raw;
      } else {
        _kbFileContentController.text = '';
      }
    } else {
      _selectedKbFileName = null;
    }
  }

  Future<void> _createNewKbFile() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Create New Knowledge Doc'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Filename (e.g. dev_setup.md)',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              var val = controller.text.trim();
              if (val.isNotEmpty) {
                if (!val.toLowerCase().endsWith('.md')) val += '.md';
                Navigator.of(context).pop(val);
              }
            },
            child: const Text('Create'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (name == null || name.isEmpty) return;

    final root = memoryStore._expandedHome(memoryStore.homePath);
    final safeProfile = memoryStore._safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
    final safeProject = memoryStore._safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
    final file = io.File('$root/memories/projects/$safeProfile/$safeProject/knowledge/$name');
    if (!await file.exists()) {
      await file.parent.create(recursive: true);
      await file.writeAsString('# $name\n\nWrite your knowledge notes here...\n');
    }
    await _loadKnowledgeBaseFiles();
    await _selectMemoryFile('kb/$name');
    final dashboard = context.read<SSHProvider>();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
  }

  Future<void> _saveActiveKbFile() async {
    if (_selectedKbFileName == null) return;
    final root = memoryStore._expandedHome(memoryStore.homePath);
    final safeProfile = memoryStore._safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
    final safeProject = memoryStore._safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
    final file = io.File('$root/memories/projects/$safeProfile/$safeProject/knowledge/$_selectedKbFileName');
    await file.writeAsString(_kbFileContentController.text);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Saved $_selectedKbFileName successfully.')));

    final dashboard = context.read<SSHProvider>();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
  }

  Future<void> _deleteKbFile(String fileName) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete $fileName?'),
        content: const Text('This will permanently delete this document from the project knowledge base.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;

    final root = memoryStore._expandedHome(memoryStore.homePath);
    final safeProfile = memoryStore._safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
    final safeProject = memoryStore._safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
    final file = io.File('$root/memories/projects/$safeProfile/$safeProject/knowledge/$fileName');
    if (await file.exists()) {
      await file.delete();
    }
    await _loadKnowledgeBaseFiles();
    if (_selectedKbFileName == fileName) {
      _selectedKbFileName = null;
      await _selectMemoryFile('soul');
    }

    final dashboard = context.read<SSHProvider>();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }
  }

  Future<Map<String, dynamic>> _readHermesSettingsFile() async {
    if (kIsWeb) {
      final raw = await _secureStorage.read(key: '${_legacyHermesSettingsKey}_non_secret');
      if (raw == null || raw.trim().isEmpty) return <String, dynamic>{};
      final decoded = jsonDecode(raw);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
    }
    final file = _hermesSettingsFile();
    if (!await file.exists()) return <String, dynamic>{};
    final raw = await file.readAsString();
    if (raw.trim().isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(raw);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
  }

  Future<void> _writeHermesSettingsFile(Map<String, dynamic> settings) async {
    final clean = Map<String, dynamic>.from(settings)..remove('apiKey');
    const encoder = JsonEncoder.withIndent('  ');
    if (kIsWeb) {
      await _secureStorage.write(key: '${_legacyHermesSettingsKey}_non_secret', value: encoder.convert(clean));
      return;
    }
    final file = _hermesSettingsFile();
    await file.parent.create(recursive: true);
    await file.writeAsString(encoder.convert(clean));
  }

  io.File _hermesSettingsFile() {
    if (!kIsWeb && io.Platform.isWindows) {
      final appData = io.Platform.environment['APPDATA'];
      final root = appData != null && appData.trim().isNotEmpty
          ? '${appData}\\ssh_dashboard'
          : r'%APPDATA%\ssh_dashboard';
      return io.File('$root\\hermes_settings_v2.json');
    }
    final home = !kIsWeb ? io.Platform.environment['HOME'] : null;
    final root = home != null && home.trim().isNotEmpty ? '$home/.ssh_dashboard' : '.ssh_dashboard';
    return io.File('$root/hermes_settings_v2.json');
  }

  Future<void> _loadSessionsList() async {
    setState(() => _loadingSessions = true);
    try {
      final dashboard = context.read<SSHProvider>();
      final list = await sessionStore.listSessions(
        profile: _settings().profile,
        project: _settings().project,
        connectedHost: dashboard.connectedHost,
      );
      setState(() {
        _sessionsList = list;
      });
    } catch (_) {
    } finally {
      setState(() => _loadingSessions = false);
    }
  }

  Future<void> _loadSession(String id) async {
    final dashboard = context.read<SSHProvider>();
    await sessionStore.load(
      profile: _settings().profile,
      project: _settings().project,
      connectedHost: dashboard.connectedHost,
      sessionId: id,
    );
    setState(() {
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      lastStatus = 'Loaded session: ${sessionStore.activeSession?.title}';
      section = _HermesStudioSection.session;
    });
    _scrollChatSoon();
  }

  Future<void> _deleteSession(String id) async {
    final dashboard = context.read<SSHProvider>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete Session?'),
        content: const Text('Are you sure you want to permanently delete this chat session?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;

    await sessionStore.deleteSession(
      profile: _settings().profile,
      project: _settings().project,
      sessionId: id,
      connectedHost: dashboard.connectedHost,
    );
    await _loadSessionsList();
    setState(() {
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
    });
  }

  Future<void> _loadLocalSkills() async {
    if (kIsWeb) return;
    setState(() => _loadingSkills = true);
    try {
      final root = sessionStore._expandedHome(hermesHomeController.text.trim());
      final skillsDir = io.Directory('$root/skills');
      if (!await skillsDir.exists()) {
        await skillsDir.create(recursive: true);
        final defaultSkillFile = io.File('${skillsDir.path}/gpu_idle_check.md');
        await defaultSkillFile.writeAsString('''---
title: GPU Idle Check
description: Monitor remote host for GPUs that have been idle for a long time.
author: Hermes
---

# GPU Idle Check
This skill scans nvidia-smi output for processes using zero memory or running below 10% utilization.
''');
      }
      final files = await skillsDir.list().where((entity) => entity is io.File && entity.path.endsWith('.md')).cast<io.File>().toList();
      setState(() {
        _localSkills = files;
      });
    } catch (_) {
    } finally {
      setState(() => _loadingSkills = false);
    }
  }

  Future<void> _writeSkill(String name, String content) async {
    if (kIsWeb) return;
    try {
      final root = sessionStore._expandedHome(hermesHomeController.text.trim());
      final file = io.File('$root/skills/$name');
      await file.parent.create(recursive: true);
      await file.writeAsString(content);
      await _loadLocalSkills();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Skill saved successfully.')));
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to save skill: $e')));
    }
  }

  Future<void> _deleteSkill(String name) async {
    if (kIsWeb) return;
    try {
      final root = sessionStore._expandedHome(hermesHomeController.text.trim());
      final file = io.File('$root/skills/$name');
      if (await file.exists()) {
        await file.delete();
      }
      await _loadLocalSkills();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Skill deleted.')));
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed to delete skill: $e')));
    }
  }

  Future<void> _manuallyApproveAndExecute(String toolName, Map<String, dynamic> args) async {
    setState(() {
      chatRequestRunning = true;
      lastStatus = 'Manually executing approved tool: $toolName...';
    });
    try {
      final dashboard = context.read<SSHProvider>();
      final settings = _settings();

      final updatedArgs = Map<String, dynamic>.from(args);
      if (updatedArgs.containsKey('approved')) {
        updatedArgs['approved'] = true;
      }

      final result = await toolGateway.call(
        tool: toolName,
        args: updatedArgs,
        dashboard: dashboard,
        settings: settings,
      );

      final injectMessage = HermesMessage(
        role: 'user',
        parts: [
          HermesMessagePart.text('[System Manual Override] User manually approved and executed the tool "$toolName" with arguments:\n${const JsonEncoder.withIndent("  ").convert(args)}\n\nResult:\n${result.output}')
        ]
      );

      sessionStore.activeSession?.messages.add(injectMessage);
      await sessionStore.save();

      setState(() {
        visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
        chatRequestRunning = false;
      });

      await _runTurn(dashboard, 'Please review the manual execution result above and continue with your plan.');
    } catch (e) {
      if (mounted) {
        setState(() {
          chatRequestRunning = false;
          lastStatus = 'Manual execution failed: $e';
        });
      }
    }
  }

  Future<void> _newSession() async {
    final settings = _settings();
    await sessionStore.newSession(
      profile: settings.profile,
      project: settings.project,
      connectedHost: context.read<SSHProvider>().connectedHost,
    );
    await _loadSessionsList();
    if (!mounted) return;
    setState(() {
      visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      lastStatus = 'New Hermes session created.';
      section = _HermesStudioSection.session;
    });
  }

  HermesAgentEngine _engine() {
    return HermesAgentEngine(
      llm: llmClient,
      sessions: sessionStore,
      memory: memoryStore,
      tools: toolGateway,
      policy: approvalPolicy,
      promptBuilder: promptBuilder,
    );
  }

  Future<void> _runTurn(SSHProvider dashboard, [String? overrideText]) async {
    final text = (overrideText ?? inputController.text).trim();
    if (text.isEmpty) return;

    if (chatRequestRunning) {
      final userMessage = HermesMessage(
        role: 'user',
        parts: [HermesMessagePart.text(text)],
      );
      sessionStore.activeSession?.messages.add(userMessage);
      await sessionStore.save();
      inputController.clear();
      if (_inputHistory.isEmpty || _inputHistory.last != text) {
        _inputHistory.add(text);
      }
      _historyIndex = -1;
      setState(() {
        visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
      });
      _scrollChatSoon();
      if (dashboard.isConnected) {
        try {
          await syncManager.syncToRemote(dashboard);
        } catch (_) {}
      }
      return;
    }

    if (_inputHistory.isEmpty || _inputHistory.last != text) {
      _inputHistory.add(text);
    }
    _historyIndex = -1;

    if (text.startsWith('/')) {
      inputController.clear();
      final cmd = text.split(' ').first.toLowerCase();
      if (cmd == '/clear') {
        await _newSession();
        return;
      } else if (cmd == '/skills') {
        setState(() {
          section = _HermesStudioSection.skills;
        });
        unawaited(_loadLocalSkills());
        return;
      } else if (cmd == '/memory' || cmd == '/soul') {
        setState(() {
          section = _HermesStudioSection.memory;
        });
        return;
      } else if (cmd == '/tasks' || cmd == '/kanban' || cmd == '/dlops') {
        setState(() {
          section = _HermesStudioSection.dlOps;
        });
        return;
      } else if (cmd == '/settings') {
        setState(() {
          section = _HermesStudioSection.settings;
        });
        return;
      } else if (cmd == '/resume') {
        final session = sessionStore.activeSession;
        if (session != null) {
          session.messages.add(
            HermesMessage(
              role: 'system',
              parts: [
                HermesMessagePart.text('💡 Please select a previous session to resume from the CHATS list in the left sidebar.'),
              ],
            ),
          );
          await sessionStore.save();
        }
        setState(() {
          section = _HermesStudioSection.session;
          visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
        });
        _scrollChatSoon();
        return;
      } else if (cmd == '/help') {
        final session = sessionStore.activeSession;
        if (session != null) {
          session.messages.add(
            HermesMessage(
              role: 'system',
              parts: [
                HermesMessagePart.text(
                  '💡 **Hermes Studio Local Slash Commands:**\n\n'
                  '* `/clear` - Start a new blank chat session.\n'
                  '* `/skills` - Navigate to the Skills Hub.\n'
                  '* `/memory` - Navigate to the SOUL Persona editor.\n'
                  '* `/tasks` - Navigate to the Tasks Kanban board.\n'
                  '* `/settings` - Open System Settings.\n'
                  '* `/resume` - Select a past session from the sidebar.'
                ),
              ],
            ),
          );
          await sessionStore.save();
        }
        setState(() {
          visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
        });
        _scrollChatSoon();
        return;
      }
    }

    final timestamp = DateTime.now().toIso8601String().substring(11, 19);
    setState(() {
      chatRequestRunning = true;
      _turnStartTime = DateTime.now();
      _turnPhase = 'Orchestrating turn...';
      _rightPanelTabIndex = 0; // Automatically switch to Console
      _rightPanelExpanded = true; // Automatically expand the panel
      _selectedConsoleStepIndex = null; // Reset selection
      _liveTraceLogs = [
        '[$timestamp] Turn initialized by user input.',
        '[$timestamp] Query: "${text.length > 80 ? '${text.substring(0, 80)}...' : text}"',
        '[$timestamp] Environment: profile = "${_settings().profile}", project = "${_settings().project}".',
      ];
      inputController.clear();
      lastStatus = 'HermesHarness is running a turn.';
      section = _HermesStudioSection.session;
    });

    _turnElapsedTimer?.cancel();
    _turnElapsedTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) setState(() {});
    });

    final input = HermesTurnInput(
      text: text,
      dashboard: dashboard,
      settings: _settings(),
    );

    await for (final event in _engine().runTurn(input)) {
      if (!mounted) return;
      final timeStr = DateTime.now().toIso8601String().substring(11, 19);
      setState(() {
        visibleMessages = List.of(sessionStore.activeSession?.messages ?? const <HermesMessage>[]);
        if (event is HermesUserMessageEvent) {
          _liveTraceLogs.add('[$timeStr] User message appended to session.');
        } else if (event is HermesToolCallProposedEvent) {
          final decisionStr = event.decision.allowed ? 'Approved' : 'Blocked';
          _liveTraceLogs.add('[$timeStr] Proposed tool: [${event.call.tool}]');
          _liveTraceLogs.add('  └─ Reason: "${event.call.reason}"');
          _liveTraceLogs.add('  └─ Policy: $decisionStr (Risk: ${event.decision.risk})');
          _turnPhase = 'Tool proposed: ${event.call.tool}';
          lastStatus = event.decision.allowed
              ? 'Tool approved by policy: ${event.call.tool}'
              : 'Tool blocked by policy: ${event.call.tool}';
        } else if (event is HermesToolResultEvent) {
          final statusStr = event.result.ok ? 'OK' : 'FAILED';
          _liveTraceLogs.add('[$timeStr] Executed: [${event.result.tool}] -> $statusStr');
          _turnPhase = 'Tool finished: ${event.result.tool}';
          lastStatus = 'Tool result recorded: ${event.result.tool} (${event.result.ok ? 'ok' : 'failed'})';
          
          // Auto select the latest step in console
          final steps = _extractStepsFromSession();
          if (steps.isNotEmpty) {
            _selectedConsoleStepIndex = steps.length - 1;
          }
        } else if (event is HermesAssistantMessageEvent) {
          _liveTraceLogs.add('[$timeStr] Model output received.');
          _turnPhase = 'Generating response...';
          lastStatus = 'Hermes answered through Google AI Studio.';
        } else if (event is HermesErrorEvent) {
          _liveTraceLogs.add('[$timeStr] ERROR: ${event.message}');
          _turnPhase = 'Error occurred';
          lastStatus = 'Hermes turn failed: ${event.message}';
        } else if (event is HermesTurnCompletedEvent) {
          _liveTraceLogs.add('[$timeStr] Turn completed successfully.');
          _turnPhase = 'Idle';
          lastStatus = 'Hermes turn completed and persisted.';
        }
      });
      _scrollChatSoon();
    }

    _turnElapsedTimer?.cancel();
    if (dashboard.isConnected) {
      try {
        await syncManager.syncToRemote(dashboard);
      } catch (_) {}
    }

    if (mounted) {
      setState(() {
        chatRequestRunning = false;
        _turnPhase = 'Idle';
      });
      await _loadSessionsList();
    }
  }

  Future<void> _testModel() async {
    if (chatRequestRunning) return;
    setState(() {
      chatRequestRunning = true;
      lastStatus = 'Testing Google AI Studio model configuration.';
    });
    try {
      final reply = await llmClient.generate(
        apiKey: apiKeyController.text,
        baseUrl: baseUrlController.text,
        model: modelController.text,
        systemPrompt: 'Reply with one concise sentence. You are only testing connectivity.',
        userPrompt: 'Say that the SSH Dashboard Hermes Google AI Studio path is reachable.',
      );
      if (!mounted) return;
      setState(() {
        visibleMessages = [
          ...visibleMessages,
          HermesMessage(role: 'system', parts: [HermesMessagePart.text('API test reply:\n$reply')]),
        ];
        lastStatus = 'Google AI Studio API test succeeded.';
      });
      _scrollChatSoon();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        visibleMessages = [
          ...visibleMessages,
          HermesMessage(role: 'system', parts: [HermesMessagePart.error('API test failed: $e')]),
        ];
        lastStatus = 'Google AI Studio API test failed.';
      });
      _scrollChatSoon();
    } finally {
      if (mounted) setState(() => chatRequestRunning = false);
    }
  }

  void _prepareGpuQuestion() {
    inputController.text = '請讀取目前 GPU 狀態，列出每張 GPU 的 utilization、memory、temperature、process/user，並建議我現在適合做什麼。';
    inputController.selection = TextSelection.collapsed(offset: inputController.text.length);
    setState(() {
      section = _HermesStudioSection.session;
      lastStatus = 'GPU question prepared. Sending it will force the gpu.snapshot dashboard tool before model answer.';
    });
  }

  void _insertIntoComposer(String text) {
    final value = inputController.value;
    final selection = value.selection;
    final source = value.text;
    final start = selection.isValid ? selection.start.clamp(0, source.length).toInt() : source.length;
    final end = selection.isValid ? selection.end.clamp(0, source.length).toInt() : source.length;
    final newText = source.replaceRange(start, end, text);
    final offset = start + text.length;
    inputController.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: offset),
      composing: TextRange.empty,
    );
  }

  void _sendFromComposer(SSHProvider provider) {
    if (inputController.text.trim().isEmpty) return;
    unawaited(_runTurn(provider));
  }

  void _applyClarificationSuggestion(String suggestion) {
    inputController.text = suggestion;
    inputController.selection = TextSelection.collapsed(offset: suggestion.length);
    inputFocusNode.requestFocus();
    setState(() {
      section = _HermesStudioSection.session;
      lastStatus = 'Clarification reply prepared. Press Enter to send, or edit it first.';
    });
  }

  Future<void> _showMemoryEditor({
    required String target,
    String? oldText,
  }) async {
    final controller = TextEditingController(text: oldText ?? '');
    final isReplace = oldText != null && oldText.trim().isNotEmpty;
    final displayTargetName = target == 'user'
        ? 'User Profile'
        : (target == 'general' ? 'General Memory' : 'Project Memory');

    final result = await showDialog<String>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: Text(isReplace ? 'Replace $displayTargetName entry' : 'Add $displayTargetName entry'),
          content: SizedBox(
            width: 560,
            child: TextField(
              controller: controller,
              autofocus: true,
              minLines: 4,
              maxLines: 10,
              decoration: InputDecoration(
                labelText: isReplace ? 'Replacement content' : 'New compact memory entry',
                helperText: target == 'user'
                    ? 'Use USER for preferences, communication style, workflow habits.'
                    : (target == 'general'
                        ? 'Use GENERAL for global context notes across all projects.'
                        : 'Use MEMORY for project-specific environment facts, conventions, and corrections.'),
                border: const OutlineInputBorder(),
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(controller.text), child: Text(isReplace ? 'Replace' : 'Add')),
          ],
        );
      },
    );
    controller.dispose();
    if (result == null || result.trim().isEmpty) return;

    final HermesMemoryToolResult memoryResult;
    if (isReplace) {
      memoryResult = await memoryStore.replace(target: target, oldText: oldText!, content: result);
    } else {
      memoryResult = await memoryStore.add(target: target, content: result);
    }

    if (!mounted) return;
    setState(() {
      lastStatus = memoryResult.success
          ? 'Hermes memory ${isReplace ? 'replaced' : 'added'} in $displayTargetName.'
          : 'Hermes memory write failed: ${memoryResult.output}';
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(memoryResult.success ? 'Memory updated.' : 'Memory update failed. Open tool event for details.')),
    );
    if (memoryResult.success) {
      final dashboard = context.read<SSHProvider>();
      if (dashboard.isConnected) {
        try {
          await syncManager.syncToRemote(dashboard);
        } catch (_) {}
      }
    }
  }

  Future<void> _removeMemoryEntry({
    required String target,
    required String oldText,
  }) async {
    final displayTargetName = target == 'user'
        ? 'User Profile'
        : (target == 'general' ? 'General Memory' : 'Project Memory');

    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove $displayTargetName entry?'),
        content: SelectableText(oldText),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    final result = await memoryStore.remove(target: target, oldText: oldText);
    if (!mounted) return;
    setState(() {
      lastStatus = result.success ? 'Hermes memory entry removed from $displayTargetName.' : 'Hermes memory remove failed: ${result.output}';
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(result.success ? 'Memory removed.' : 'Memory remove failed.')),
    );
    if (result.success) {
      final dashboard = context.read<SSHProvider>();
      if (dashboard.isConnected) {
        try {
          await syncManager.syncToRemote(dashboard);
        } catch (_) {}
      }
    }
  }

  String _defaultHermesHome() {
    if (!kIsWeb && io.Platform.isWindows) {
      final appData = io.Platform.environment['APPDATA'];
      if (appData != null && appData.trim().isNotEmpty) {
        return '$appData\\cozypad_hermes';
      }
      return r'%APPDATA%\cozypad_hermes';
    }
    final home = !kIsWeb ? io.Platform.environment['HOME'] : null;
    if (home != null && home.trim().isNotEmpty) {
      return '$home/.cozypad_hermes';
    }
    return '~/.cozypad_hermes';
  }

  String _maskedSecret(String value) {
    final clean = value.trim();
    if (clean.isEmpty) return 'not set';
    if (clean.length <= 8) return '••••';
    return '${clean.substring(0, 4)}••••${clean.substring(clean.length - 4)}';
  }

  void _scrollChatSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !chatScrollController.hasClients) return;
      chatScrollController.animateTo(
        chatScrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final provider = context.watch<SSHProvider>();

    return Row(
      children: [
        SizedBox(
          width: 280,
          child: _buildBeautifulSidebar(provider),
        ),
        const VerticalDivider(width: 1),
        Expanded(
          child: Column(
            children: [
              _HermesTopBar(
                connectedHost: provider.connectedHost,
                profile: _settings().profile,
                project: _settings().project,
                status: lastStatus,
                isRunning: chatRequestRunning,
                onRefreshResources: () => unawaited(provider.refreshAll()),
                onSendGpuContext: _prepareGpuQuestion,
              ),
              const Divider(height: 1),
              Expanded(child: _buildSection(provider)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildBeautifulSidebar(SSHProvider provider) {
    final items = [
      (_HermesStudioSection.overview, Icons.dashboard, 'Overview'),
      (_HermesStudioSection.session, Icons.chat, 'Chat Session'),
      (_HermesStudioSection.profiles, Icons.api, 'API Providers'),
      (_HermesStudioSection.skills, Icons.construction, 'Skills Hub'),
      (_HermesStudioSection.dlOps, Icons.splitscreen, 'Tasks Kanban'),
      (_HermesStudioSection.memory, Icons.psychology, 'SOUL Persona'),
      (_HermesStudioSection.settings, Icons.tune, 'System Settings'),
      (_HermesStudioSection.security, Icons.security, 'Security Baseline'),
      (_HermesStudioSection.gateways, Icons.hub, 'Remote Runtime'),
    ];

    return Container(
      color: AppPalette.backgroundDeep,
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome, color: AppPalette.accent),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Hermes Studio',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                    color: AppPalette.textPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'profile: ${_settings().profile} · project: ${_settings().project}',
            style: TextStyle(color: AppPalette.textMuted, fontSize: 11),
          ),
          const SizedBox(height: 8),
          _buildQuickApiSwitcher(provider),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _newSession,
              icon: const Icon(Icons.add, size: 16),
              label: const Text('New session', style: TextStyle(fontSize: 12)),
              style: FilledButton.styleFrom(
                backgroundColor: AppPalette.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                padding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text('CHATS', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: AppPalette.textMuted, fontWeight: FontWeight.bold, letterSpacing: 1.1)),
          const SizedBox(height: 6),
          Expanded(
            child: _loadingSessions
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : _sessionsList.isEmpty
                    ? const Center(child: Text('No saved chats', style: TextStyle(color: Colors.white24, fontSize: 11)))
                    : Scrollbar(
                        controller: sidebarChatsScrollController,
                        thumbVisibility: true,
                        child: ListView.builder(
                          controller: sidebarChatsScrollController,
                          itemCount: _sessionsList.length,
                          itemBuilder: (context, index) {
                            final sess = _sessionsList[index];
                            final isCurrent = sessionStore.activeSession?.id == sess.id;
                            return Container(
                              margin: const EdgeInsets.only(bottom: 4),
                              decoration: BoxDecoration(
                                color: isCurrent ? AppPalette.surfaceSoft : Colors.transparent,
                                border: isCurrent
                                    ? Border(left: BorderSide(color: AppPalette.accent, width: 3))
                                    : null,
                                borderRadius: isCurrent
                                    ? const BorderRadius.only(
                                        topRight: Radius.circular(8),
                                        bottomRight: Radius.circular(8),
                                        topLeft: Radius.circular(2),
                                        bottomLeft: Radius.circular(2),
                                      )
                                    : BorderRadius.circular(8),
                              ),
                              child: ListTile(
                                dense: true,
                                contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                leading: Icon(
                                  isCurrent ? Icons.chat_bubble : Icons.chat_bubble_outline,
                                  size: 14,
                                  color: isCurrent ? AppPalette.accent : AppPalette.textMuted,
                                ),
                                title: Text(
                                  sess.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontWeight: isCurrent ? FontWeight.bold : FontWeight.normal,
                                    color: isCurrent ? AppPalette.textPrimary : AppPalette.textSecondary,
                                    fontSize: 12,
                                  ),
                                ),
                                subtitle: Padding(
                                  padding: const EdgeInsets.only(top: 2),
                                  child: Text(
                                    sess.updatedAt.toIso8601String().substring(0, 16).replaceAll('T', ' '),
                                    style: TextStyle(
                                      color: AppPalette.textMuted,
                                      fontSize: 10,
                                    ),
                                  ),
                                ),
                                trailing: IconButton(
                                  icon: Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                                  onPressed: () => _deleteSession(sess.id),
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(),
                                ),
                                onTap: () => _loadSession(sess.id),
                              ),
                            );
                          },
                        ),
                      ),
          ),
          const Divider(),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final item in items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: ListTile(
                    dense: true,
                    visualDensity: VisualDensity.compact,
                    selected: section == item.$1,
                    selectedTileColor: AppPalette.accent.withOpacity(0.08),
                    selectedColor: AppPalette.accent,
                    textColor: AppPalette.textSecondary,
                    iconColor: AppPalette.textMuted,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                    leading: Icon(item.$2, size: 15),
                    title: Text(item.$3, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
                    onTap: () {
                      setState(() => section = item.$1);
                      if (item.$1 == _HermesStudioSection.session) {
                        unawaited(_loadSessionsList());
                      } else if (item.$1 == _HermesStudioSection.skills) {
                        unawaited(_loadLocalSkills());
                      }
                    },
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildSlashCommandSuggestions(SSHProvider provider) {
    final text = inputController.text;
    if (!text.startsWith('/')) return const SizedBox.shrink();

    final filtered = _allSlashCommands
        .where((c) => c['cmd']!.startsWith(text.toLowerCase()))
        .toList();
    if (filtered.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: AppPalette.surfaceSoft,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: filtered.asMap().entries.map((entry) {
          final idx = entry.key;
          final c = entry.value;
          final isSelected = _selectedSuggestionIndex == idx;
          return Container(
            margin: const EdgeInsets.only(bottom: 2),
            decoration: BoxDecoration(
              color: isSelected ? AppPalette.accent.withOpacity(0.12) : Colors.transparent,
              border: isSelected
                  ? Border(left: BorderSide(color: AppPalette.accent, width: 3))
                  : null,
              borderRadius: BorderRadius.circular(4),
            ),
            child: ListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              leading: Icon(Icons.terminal, size: 14, color: AppPalette.accent),
              title: Text(
                c['cmd']!,
                style: TextStyle(
                  fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                  color: isSelected ? AppPalette.accent : AppPalette.textPrimary,
                  fontSize: 12,
                ),
              ),
              trailing: Text(
                c['desc']!,
                style: TextStyle(
                  color: AppPalette.textMuted,
                  fontSize: 11,
                ),
              ),
              onTap: () {
                setState(() {
                  inputController.text = c['cmd']!;
                  inputController.selection = TextSelection.collapsed(offset: c['cmd']!.length);
                  _selectedSuggestionIndex = idx;
                });
              },
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _buildSection(SSHProvider provider) {
    switch (section) {
      case _HermesStudioSection.overview:
        return _buildOverview(provider);
      case _HermesStudioSection.settings:
        return _buildSettings();
      case _HermesStudioSection.session:
        return _buildSession(provider);
      case _HermesStudioSection.profiles:
        return _buildApiProfilesGrid();
      case _HermesStudioSection.skills:
        return _buildSkillsGrid();
      case _HermesStudioSection.dlOps:
        return _buildTasksKanban(provider);
      case _HermesStudioSection.memory:
        return _buildSoulPersonaEditor();
      case _HermesStudioSection.security:
        return _buildSecurity();
      case _HermesStudioSection.gateways:
        return _buildGateway(provider);
      default:
        return _buildOverview(provider);
    }
  }

  Widget _buildOverview(SSHProvider provider) {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        _HermesPanel(
          title: 'Milestone C/D: Hermes Workspace',
          icon: Icons.auto_awesome,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'This version implements a unified workspace layout matching hermes-desktop: multi-PC context, session history lists, a visually interactive Skills Hub, SOUL.md operating editor, a project tasks Kanban board, and a live hardware context sidebar.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  const _HermesPill(icon: Icons.done, label: 'Session History Sidebar'),
                  const _HermesPill(icon: Icons.done, label: 'Skills Hub Grid'),
                  const _HermesPill(icon: Icons.done, label: 'SOUL.md Editor'),
                  _HermesPill(icon: Icons.cloud, label: 'Model: ${_settings().model}'),
                  _HermesPill(icon: Icons.dns, label: 'SSH target: ${provider.connectedHost ?? '-'}'),
                  _HermesPill(icon: Icons.memory, label: 'GPUs: ${provider.gpus.length}'),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  FilledButton.icon(
                    onPressed: () => setState(() => section = _HermesStudioSection.session),
                    icon: const Icon(Icons.chat),
                    label: const Text('Open Hermes Session'),
                  ),
                  const SizedBox(width: 10),
                  OutlinedButton.icon(
                    onPressed: _prepareGpuQuestion,
                    icon: const Icon(Icons.memory),
                    label: const Text('Ask GPU status'),
                  ),
                  const SizedBox(width: 10),
                  OutlinedButton.icon(
                    onPressed: () => setState(() => section = _HermesStudioSection.settings),
                    icon: const Icon(Icons.tune),
                    label: const Text('Settings'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        ResponsiveGrid(
          itemCount: featureSpecs.length,
          minItemWidth: 320,
          childAspectRatio: 1.45,
          itemBuilder: (context, index) => _HermesFeatureCard(spec: featureSpecs[index]),
        ),
      ],
    );
  }

  Widget _buildSettings() {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        _HermesPanel(
          title: 'Google AI Studio / Gemini API',
          icon: Icons.key,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Only the model call belongs to Google AI Studio. The API key is a separate secure-storage secret; model, workspace, and policy settings are stored as non-secret local JSON.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: modelController,
                      decoration: const InputDecoration(labelText: 'Google model', border: OutlineInputBorder(), isDense: true),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextField(
                      controller: baseUrlController,
                      decoration: const InputDecoration(labelText: 'Gemini API base URL', border: OutlineInputBorder(), isDense: true),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextField(
                controller: apiKeyController,
                obscureText: hideSecrets,
                decoration: InputDecoration(
                  labelText: 'Google AI Studio API key',
                  border: const OutlineInputBorder(),
                  isDense: true,
                  suffixIcon: IconButton(
                    tooltip: hideSecrets ? 'Show secret' : 'Hide secret',
                    onPressed: () => setState(() => hideSecrets = !hideSecrets),
                    icon: Icon(hideSecrets ? Icons.visibility : Icons.visibility_off),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _HermesPill(icon: Icons.lock, label: 'API key: ${_maskedSecret(apiKeyController.text)}'),
                  const _HermesPill(icon: Icons.cloud, label: 'Google AI Studio only'),
                  const _HermesPill(icon: Icons.integration_instructions, label: 'No OpenAI-compatible provider zoo'),
                  const _HermesPill(icon: Icons.storage, label: 'Non-secret settings in local JSON'),
                ],
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  FilledButton.icon(
                    onPressed: _saveHermesSettings,
                    icon: const Icon(Icons.save),
                    label: const Text('Save settings'),
                  ),
                  const SizedBox(width: 10),
                  OutlinedButton.icon(
                    onPressed: chatRequestRunning ? null : _testModel,
                    icon: const Icon(Icons.network_check),
                    label: const Text('Test model'),
                  ),
                  const SizedBox(width: 10),
                  TextButton.icon(
                    onPressed: _resetHermesSettings,
                    icon: const Icon(Icons.restart_alt),
                    label: const Text('Reset'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _HermesPanel(
          title: 'Hermes workspace',
          icon: Icons.account_tree,
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(child: TextField(controller: hermesHomeController, decoration: const InputDecoration(labelText: 'Hermes home / local store root', border: OutlineInputBorder(), isDense: true))),
                  const SizedBox(width: 10),
                  Expanded(child: TextField(controller: profileController, decoration: const InputDecoration(labelText: 'Profile', border: OutlineInputBorder(), isDense: true))),
                  const SizedBox(width: 10),
                  Expanded(child: TextField(controller: projectController, decoration: const InputDecoration(labelText: 'Project', border: OutlineInputBorder(), isDense: true))),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _HermesPanel(
          title: 'Tool and approval policy',
          icon: Icons.policy,
          child: Column(
            children: [
              _HermesSwitchLine(
                value: allowRemoteTools,
                title: 'Allow dashboard SSH/GPU/file tools',
                subtitle: 'Read-only dashboard tools can be used by HermesHarness through HermesToolGateway after registry and approval-policy checks.',
                onChanged: (value) => setState(() => allowRemoteTools = value),
              ),
              _HermesSwitchLine(
                value: requireApprovalDestructive,
                title: 'Require approval for destructive actions',
                subtitle: 'Mutating tools like ssh.run_approved, file.write_text present interactive chips for manual approval.',
                onChanged: (value) => setState(() => requireApprovalDestructive = value),
              ),
              _HermesSwitchLine(
                value: requireApprovalGpuPreempt,
                title: 'Require approval for GPU process preemption',
                subtitle: 'kill/pkill/preempt tools are not registered in this pass.',
                onChanged: (value) => setState(() => requireApprovalGpuPreempt = value),
              ),
              _HermesSwitchLine(
                value: requireApprovalMultiGpu,
                title: 'Require approval for multi-GPU launches',
                subtitle: 'Launch tools should become approval-gated task drafts in a later milestone.',
                onChanged: (value) => setState(() => requireApprovalMultiGpu = value),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSession(SSHProvider provider) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: Column(
            children: [
              Expanded(
                child: visibleMessages.isEmpty
                    ? Center(
                        child: Text(
                          'Ask Hermes something. GPU/resource questions will force a real gpu.snapshot tool call before the model answers.',
                          style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white60),
                          textAlign: TextAlign.center,
                        ),
                      )
                    : ListView.builder(
                        controller: chatScrollController,
                        padding: const EdgeInsets.all(18),
                        itemCount: visibleMessages.length,
                        itemBuilder: (context, index) => _HermesMessageCard(
                          message: visibleMessages[index], 
                          onUseSuggestion: _applyClarificationSuggestion,
                          onApprove: _manuallyApproveAndExecute,
                        ),
                      ),
              ),
              const Divider(height: 1),
              _buildChoicesList(_extractSessionChoices()),
              _buildSlashCommandSuggestions(provider),
              Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      child: CallbackShortcuts(
                        bindings: <ShortcutActivator, VoidCallback>{
                          const SingleActivator(LogicalKeyboardKey.enter): () => _sendFromComposer(provider),
                          const SingleActivator(LogicalKeyboardKey.numpadEnter): () => _sendFromComposer(provider),
                          const SingleActivator(LogicalKeyboardKey.enter, shift: true): () => _insertIntoComposer('\n'),
                          const SingleActivator(LogicalKeyboardKey.numpadEnter, shift: true): () => _insertIntoComposer('\n'),
                        },
                        child: TextField(
                          controller: inputController,
                          focusNode: inputFocusNode,
                          minLines: 1,
                          maxLines: 5,
                          keyboardType: TextInputType.multiline,
                          textInputAction: TextInputAction.newline,
                          onChanged: (val) => setState(() {}),
                          decoration: InputDecoration(
                            labelText: 'Message Hermes',
                            hintText: 'Enter 送出，Shift+Enter 換行。例：目前 GPU 狀態如何？',
                            border: const OutlineInputBorder(),
                            suffixIcon: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                IconButton(
                                  tooltip: 'Paste image from clipboard',
                                  onPressed: _pasteImage,
                                  icon: const Icon(Icons.image_outlined),
                                ),
                                IconButton(
                                  tooltip: 'Prepare GPU status question',
                                  onPressed: _prepareGpuQuestion,
                                  icon: const Icon(Icons.memory),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    FilledButton.icon(
                      onPressed: inputController.text.trim().isEmpty ? null : () => _runTurn(provider),
                      icon: chatRequestRunning
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Icon(Icons.send),
                      label: const Text('Send'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        _buildRightContextPanel(provider),
      ],
    );
  }

  Widget _buildRightContextPanel(SSHProvider provider) {
    if (!_rightPanelExpanded) {
      return Container(
        width: 45,
        color: AppPalette.backgroundDeep,
        child: Column(
          children: [
            const SizedBox(height: 10),
            IconButton(
              icon: const Icon(Icons.chevron_left),
              onPressed: () => setState(() => _rightPanelExpanded = true),
              tooltip: 'Expand context panel',
            ),
            const SizedBox(height: 20),
            RotatedBox(
              quarterTurns: 1,
              child: Text(
                _rightPanelTabIndex == 0
                    ? 'Console'
                    : _rightPanelTabIndex == 1
                        ? 'Memory'
                        : _rightPanelTabIndex == 2
                            ? 'GPU Telemetry'
                            : 'Tasks',
                style: const TextStyle(fontWeight: FontWeight.bold, letterSpacing: 1.2, fontSize: 11),
              ),
            ),
          ],
        ),
      );
    }

    return SizedBox(
      width: 380,
      child: Container(
        color: AppPalette.backgroundDeep,
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              color: AppPalette.surface,
              child: Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.chevron_right),
                    onPressed: () => setState(() => _rightPanelExpanded = false),
                    tooltip: 'Collapse panel',
                  ),
                  Expanded(
                    child: SegmentedButton<int>(
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(value: 0, label: Text('Console', style: TextStyle(fontSize: 10))),
                        ButtonSegment(value: 1, label: Text('Memory', style: TextStyle(fontSize: 10))),
                        ButtonSegment(value: 2, label: Text('GPU', style: TextStyle(fontSize: 10))),
                        ButtonSegment(value: 3, label: Text('Tasks', style: TextStyle(fontSize: 10))),
                      ],
                      selected: {_rightPanelTabIndex},
                      onSelectionChanged: (set) => setState(() => _rightPanelTabIndex = set.first),
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: _rightPanelTabIndex == 0
                  ? _buildAgentConsolePanel(provider)
                  : _rightPanelTabIndex == 1
                      ? _buildMemoryPanelInContext()
                      : _rightPanelTabIndex == 2
                          ? _buildGpuPanelInContext(provider)
                          : _buildTasksPanelInContext(provider),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMemoryPanelInContext() {
    return FutureBuilder<HermesMemorySnapshot>(
      future: memoryStore.loadSnapshot(),
      builder: (context, snapshot) {
        final data = snapshot.data;
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (data == null) {
          return const Center(child: Text('Failed to load memory snapshot.'));
        }

        return ListView(
          padding: const EdgeInsets.all(12),
          children: [
            Row(
              children: [
                Icon(Icons.folder_shared_outlined, color: AppPalette.accent, size: 16),
                const SizedBox(width: 8),
                Text('Project Memory', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppPalette.surfaceSoft,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: AppPalette.border),
                  ),
                  child: Text(
                    '${memoryStore.profile}/${memoryStore.project}',
                    style: TextStyle(fontSize: 9, color: AppPalette.textSecondary),
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.add, size: 16),
                  onPressed: () => _showMemoryEditor(target: 'memory'),
                  tooltip: 'Add project memory entry',
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (data.memory.entries.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No project-specific memory entries.', style: TextStyle(color: Colors.white30, fontSize: 11)),
              )
            else
              ...data.memory.entries.map((entry) => _buildContextMemoryEntryCard('memory', entry)),
            
            const Divider(height: 24),
            Row(
              children: [
                Icon(Icons.psychology, color: AppPalette.accent, size: 16),
                const SizedBox(width: 8),
                Text('General Memory', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.add, size: 16),
                  onPressed: () => _showMemoryEditor(target: 'general'),
                  tooltip: 'Add general memory entry',
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (data.general.entries.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No general memory entries.', style: TextStyle(color: Colors.white30, fontSize: 11)),
              )
            else
              ...data.general.entries.map((entry) => _buildContextMemoryEntryCard('general', entry)),

            const Divider(height: 24),
            Row(
              children: [
                Icon(Icons.person_outline, color: AppPalette.accent, size: 16),
                const SizedBox(width: 8),
                Text('User Profile', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.add, size: 16),
                  onPressed: () => _showMemoryEditor(target: 'user'),
                  tooltip: 'Add user preference',
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (data.user.entries.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No user preferences recorded.', style: TextStyle(color: Colors.white30, fontSize: 11)),
              )
            else
              ...data.user.entries.map((entry) => _buildContextMemoryEntryCard('user', entry)),
          ],
        );
      },
    );
  }

  Widget _buildContextMemoryEntryCard(String target, String entry) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(entry, style: const TextStyle(fontSize: 11, height: 1.3)),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              IconButton(
                icon: const Icon(Icons.edit, size: 12),
                onPressed: () => _showMemoryEditor(target: target, oldText: entry),
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Edit entry',
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: Icon(Icons.delete_outline, size: 12, color: AppPalette.danger),
                onPressed: () => _removeMemoryEntry(target: target, oldText: entry),
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Delete entry',
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildGpuPanelInContext(SSHProvider provider) {
    if (provider.gpus.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.developer_board_off, size: 36, color: Colors.white24),
            const SizedBox(height: 10),
            Text('No GPUs detected on ${provider.connectedHost ?? 'remote'}', style: const TextStyle(color: Colors.white30, fontSize: 12)),
          ],
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: provider.gpus.length,
      itemBuilder: (context, index) {
        final gpu = provider.gpus[index];
        final util = gpu.usage / 100.0;
        final memUsed = gpu.memoryUsedMb;
        final memTotal = gpu.memoryTotalMb;
        final memRatio = (memUsed / memTotal).clamp(0.0, 1.0);
        
        return Card(
          color: AppPalette.surface,
          margin: const EdgeInsets.only(bottom: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: AppPalette.border),
          ),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(Icons.memory, size: 14, color: AppPalette.accent),
                    const SizedBox(width: 6),
                    Text(
                      'GPU $index: ${gpu.name}',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Text('Utilization', style: TextStyle(fontSize: 10, color: AppPalette.textSecondary)),
                    const Spacer(),
                    Text('${gpu.usage.toStringAsFixed(0)}%', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold)),
                  ],
                ),
                const SizedBox(height: 4),
                LinearProgressIndicator(value: util, color: Colors.orangeAccent, backgroundColor: Colors.white10, minHeight: 4),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Text('VRAM Memory', style: TextStyle(fontSize: 10, color: AppPalette.textSecondary)),
                    const Spacer(),
                    Text('${memUsed.toStringAsFixed(0)} / ${memTotal.toStringAsFixed(0)} MB', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold)),
                  ],
                ),
                const SizedBox(height: 4),
                LinearProgressIndicator(value: memRatio, color: AppPalette.accent, backgroundColor: Colors.white10, minHeight: 4),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Icon(Icons.thermostat, size: 12, color: Colors.redAccent),
                    const SizedBox(width: 4),
                    Text('Temp: ${gpu.temperature}°C', style: const TextStyle(fontSize: 10, color: Colors.white54)),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildTasksPanelInContext(SSHProvider provider) {
    if (provider.tasks.isEmpty) {
      return const Center(child: Text('No active tasks tracked.', style: TextStyle(color: Colors.white24, fontSize: 12)));
    }

    final activeTasks = provider.tasks.where((t) => t.status == 'running').toList();
    if (activeTasks.isEmpty) {
      return const Center(child: Text('No running tasks.', style: TextStyle(color: Colors.white24, fontSize: 12)));
    }

    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: activeTasks.length,
      itemBuilder: (context, index) {
        final task = activeTasks[index];
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: AppPalette.surface,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppPalette.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.circle, size: 6, color: Colors.orangeAccent),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      task.title,
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                task.command ?? '',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 9, color: Colors.white54),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildAgentConsolePanel(SSHProvider provider) {
    final steps = _extractStepsFromSession();
    final elapsedText = _getElapsedText();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          color: AppPalette.surfaceSoft,
          child: Row(
            children: [
              _AgentConsoleStatusDot(active: chatRequestRunning),
              const SizedBox(width: 8),
              Text(
                chatRequestRunning ? 'AGENT ACTIVE' : 'AGENT IDLE',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 12,
                  color: chatRequestRunning ? AppPalette.success : AppPalette.textMuted,
                  letterSpacing: 0.5,
                ),
              ),
              const Spacer(),
              if (chatRequestRunning && elapsedText.isNotEmpty)
                Text(
                  'Elapsed: $elapsedText',
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: AppPalette.textSecondary,
                  ),
                ),
            ],
          ),
        ),
        if (chatRequestRunning && _turnPhase.isNotEmpty)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            color: AppPalette.surfaceSoft.withOpacity(0.5),
            child: Text(
              _turnPhase,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: AppPalette.textSecondary, fontStyle: FontStyle.italic),
            ),
          ),
        const Divider(height: 1),
        Expanded(
          child: steps.isEmpty
              ? _buildConsoleEmptyState()
              : Column(
                  children: [
                    Expanded(
                      flex: 4,
                      child: ListView.builder(
                        itemCount: steps.length,
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        itemBuilder: (context, index) {
                          final step = steps[index];
                          final isSelected = _selectedConsoleStepIndex == index || 
                              (_selectedConsoleStepIndex == null && index == steps.length - 1);
                          return _buildConsoleStepCard(step, index, isSelected);
                        },
                      ),
                    ),
                    const Divider(height: 1),
                    Expanded(
                      flex: 5,
                      child: _buildConsoleStepInspector(steps),
                    ),
                  ],
                ),
        ),
        const Divider(height: 1),
        Container(
          height: 140,
          color: const Color(0xFF090D16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                color: Colors.black26,
                child: Row(
                  children: [
                    Icon(Icons.terminal, size: 12, color: AppPalette.textMuted),
                    SizedBox(width: 6),
                    Text('LIVE LOGS', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textMuted, letterSpacing: 0.5)),
                  ],
                ),
              ),
              Expanded(
                child: _buildConsoleLogsTerminal(),
              ),
            ],
          ),
        ),
      ],
    );
  }

  String _getElapsedText() {
    if (_turnStartTime == null) return '';
    final diff = DateTime.now().difference(_turnStartTime!);
    final mins = diff.inMinutes.toString().padLeft(2, '0');
    final secs = (diff.inSeconds % 60).toString().padLeft(2, '0');
    return '$mins:$secs';
  }

  Widget _buildConsoleEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.auto_awesome, size: 42, color: AppPalette.textMuted.withOpacity(0.3)),
          const SizedBox(height: 12),
          Text(
            'Ready for execution',
            style: TextStyle(fontWeight: FontWeight.bold, color: AppPalette.textSecondary),
          ),
          const SizedBox(height: 4),
          Text(
            'Send a prompt to trigger agent actions.',
            style: TextStyle(fontSize: 11, color: AppPalette.textMuted),
          ),
        ],
      ),
    );
  }

  Widget _buildConsoleStepCard(_AgentStepData step, int index, bool isSelected) {
    IconData getToolIcon(String tool) {
      switch (tool) {
        case 'gpu.snapshot': return Icons.developer_board;
        case 'task.list': return Icons.list_alt;
        case 'file.list': return Icons.folder_open;
        case 'file.read_text': return Icons.description;
        case 'file.write_text': return Icons.edit_note;
        case 'ssh.run_readonly': return Icons.terminal;
        case 'ssh.run_approved': return Icons.play_arrow;
        case 'memory': return Icons.psychology;
        default: return Icons.construction;
      }
    }

    final toolIcon = getToolIcon(step.tool);
    
    Color getStatusColor() {
      if (step.ok == null) return Colors.amber;
      return step.ok! ? AppPalette.success : AppPalette.danger;
    }

    return InkWell(
      onTap: () => setState(() => _selectedConsoleStepIndex = index),
      child: Container(
        color: isSelected ? AppPalette.surface : null,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Column(
              children: [
                Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: getStatusColor().withOpacity(0.1),
                    shape: BoxShape.circle,
                    border: Border.all(color: getStatusColor().withOpacity(0.5), width: 1.5),
                  ),
                  child: step.ok == null
                      ? const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 1.5, color: Colors.amber),
                        )
                      : Icon(
                          step.ok! ? Icons.check : Icons.close,
                          size: 12,
                          color: getStatusColor(),
                        ),
                ),
              ],
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(toolIcon, size: 13, color: AppPalette.textSecondary),
                      const SizedBox(width: 6),
                      Text(
                        'Step ${index + 1}: ${step.tool}',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: isSelected ? FontWeight.w900 : FontWeight.w700,
                          color: isSelected ? AppPalette.textPrimary : AppPalette.textSecondary,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    step.reason,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildConsoleStepInspector(List<_AgentStepData> steps) {
    final activeIndex = _selectedConsoleStepIndex ?? (steps.isNotEmpty ? steps.length - 1 : null);
    if (activeIndex == null || activeIndex >= steps.length) {
      return Center(child: Text('Select a step to inspect details', style: TextStyle(color: AppPalette.textMuted, fontSize: 11)));
    }

    final step = steps[activeIndex];
    final argsJson = const JsonEncoder.withIndent('  ').convert(step.args);
    final output = step.output ?? (step.ok == null ? 'Step is currently executing...' : 'No output recorded.');

    return DefaultTabController(
      length: 2,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: AppPalette.background,
            child: const TabBar(
              labelStyle: TextStyle(fontSize: 10, fontWeight: FontWeight.bold),
              unselectedLabelStyle: TextStyle(fontSize: 10),
              indicatorSize: TabBarIndicatorSize.tab,
              tabs: [
                Tab(text: 'OBSERVATION'),
                Tab(text: 'ARGUMENTS'),
              ],
            ),
          ),
          Expanded(
            child: TabBarView(
              children: [
                Container(
                  color: const Color(0xFF030712),
                  padding: const EdgeInsets.all(8),
                  child: SingleChildScrollView(
                    child: SelectionArea(
                      child: Text(
                        output,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 11,
                          color: Color(0xFFE2E8F0),
                          height: 1.3,
                        ),
                      ),
                    ),
                  ),
                ),
                Container(
                  color: const Color(0xFF030712),
                  padding: const EdgeInsets.all(8),
                  child: SingleChildScrollView(
                    child: SelectionArea(
                      child: Text(
                        argsJson,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 11,
                          color: Color(0xFF38BDF8),
                          height: 1.3,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildConsoleLogsTerminal() {
    final logsToRender = _liveTraceLogs.isNotEmpty
        ? _liveTraceLogs
        : ['[System] Console ready. Send a message to start tracing active operations.'];

    return Container(
      padding: const EdgeInsets.all(8),
      child: ListView.builder(
        itemCount: logsToRender.length,
        reverse: true,
        itemBuilder: (context, index) {
          final log = logsToRender[logsToRender.length - 1 - index];
          
          Color getLogColor() {
            if (log.contains('ERROR')) return Colors.redAccent;
            if (log.contains('Executed')) return Colors.greenAccent;
            if (log.contains('Proposed')) return Colors.orangeAccent;
            if (log.contains('Model output')) return Colors.cyanAccent;
            return Colors.white70;
          }

          return Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              log,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10.5,
                color: getLogColor(),
                height: 1.25,
              ),
            ),
          );
        },
      ),
    );
  }

  List<_AgentStepData> _extractStepsFromSession() {
    final steps = <_AgentStepData>[];
    if (sessionStore.activeSession == null) return steps;
    
    _AgentStepData? currentStep;
    
    for (final message in sessionStore.activeSession!.messages) {
      for (final part in message.parts) {
        if (part.type == 'tool_call') {
          final tool = part.metadata['tool']?.toString() ?? '';
          final args = part.metadata['args'] is Map ? Map<String, dynamic>.from(part.metadata['args'] as Map) : <String, dynamic>{};
          final reason = part.text;
          
          currentStep = _AgentStepData(
            tool: tool,
            args: args,
            reason: reason,
            timestamp: message.createdAt,
          );
          steps.add(currentStep);
        } else if (part.type == 'tool_result' && currentStep != null && currentStep.tool == part.metadata['tool']) {
          currentStep.ok = part.metadata['ok'] == true;
          currentStep.output = part.text;
          currentStep.completedAt = message.createdAt;
        }
      }
    }
    return steps;
  }

  Widget _buildSkillsGrid() {
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.construction, color: AppPalette.accent, size: 24),
              const SizedBox(width: 10),
              Text('Skills Hub', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
              const Spacer(),
              FilledButton.icon(
                onPressed: () => _showSkillEditor(),
                icon: const Icon(Icons.add),
                label: const Text('Add Custom Skill'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'Skills are executable procedures stored as local Markdown files under hermes_home/skills. They define custom workflows like GPU monitoring or training runs.',
            style: TextStyle(color: AppPalette.textMuted, fontSize: 13),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: _loadingSkills
                ? const Center(child: CircularProgressIndicator())
                : _localSkills.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.developer_mode, size: 48, color: Colors.white24),
                            const SizedBox(height: 12),
                            Text('No custom skills created yet.', style: TextStyle(color: AppPalette.textMuted)),
                          ],
                        ),
                      )
                    : GridView.builder(
                        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 320,
                          childAspectRatio: 1.4,
                          crossAxisSpacing: 14,
                          mainAxisSpacing: 14,
                        ),
                        itemCount: _localSkills.length,
                        itemBuilder: (context, index) {
                          final file = _localSkills[index];
                          final filename = file.path.split(io.Platform.isWindows ? '\\' : '/').last;
                          return Card(
                            color: AppPalette.surface,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                              side: BorderSide(color: AppPalette.border),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Icon(Icons.description, color: AppPalette.accent, size: 18),
                                      const SizedBox(width: 6),
                                      Expanded(
                                        child: Text(
                                          filename.replaceAll('.md', '').toUpperCase(),
                                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  Expanded(
                                    child: Text(
                                      'Procedure file: $filename\nCreated to orchestrate workspace deep learning tasks.',
                                      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70),
                                      maxLines: 3,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                  const Spacer(),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      TextButton.icon(
                                        onPressed: () => _showSkillEditor(file),
                                        icon: const Icon(Icons.edit, size: 14),
                                        label: const Text('Edit', style: TextStyle(fontSize: 11)),
                                      ),
                                      IconButton(
                                        icon: Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                                        onPressed: () => _deleteSkill(filename),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }

  Future<void> _showSkillEditor([io.File? file]) async {
    String name = file != null ? file.path.split(io.Platform.isWindows ? '\\' : '/').last : 'new_skill.md';
    String content = file != null ? await file.readAsString() : '''---
title: New Skill
description: Describe what this skill does.
author: User
---

# New Skill
Write your skill workflow here.
''';

    final nameController = TextEditingController(text: name);
    final contentController = TextEditingController(text: content);

    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(file != null ? 'Edit Skill: $name' : 'Create New Skill'),
        content: SizedBox(
          width: 700,
          height: 500,
          child: Column(
            children: [
              if (file == null) ...[
                TextField(
                  controller: nameController,
                  decoration: const InputDecoration(labelText: 'Skill filename (must end in .md)', hintText: 'gpu_monitor.md'),
                ),
                const SizedBox(height: 10),
              ],
              Expanded(
                child: TextField(
                  controller: contentController,
                  maxLines: null,
                  expands: true,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                  decoration: const InputDecoration(
                    labelText: 'Markdown / YAML frontmatter content',
                    alignLabelWithHint: true,
                  ),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Save')),
        ],
      ),
    );

    if (result == true) {
      final finalName = nameController.text.trim();
      final finalContent = contentController.text;
      if (finalName.isNotEmpty && finalName.endsWith('.md')) {
        await _writeSkill(finalName, finalContent);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invalid filename. Must end in .md')));
      }
    }
    nameController.dispose();
    contentController.dispose();
  }

  Widget _buildTasksKanban(SSHProvider provider) {
    final tasks = provider.tasks;
    final todo = tasks.where((t) => t.status == 'pending' || t.status == 'draft').toList();
    final inProgress = tasks.where((t) => t.status == 'running' || t.status == 'executing').toList();
    final done = tasks.where((t) => t.status == 'success' || t.status == 'failed' || t.status == 'cancelled').toList();

    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.splitscreen, color: AppPalette.accent, size: 24),
              const SizedBox(width: 10),
              Text('Task Kanban Board', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
              const Spacer(),
              IconButton(
                onPressed: () => unawaited(provider.refreshAll()),
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh tasks',
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _buildKanbanColumn('To Do', todo, Colors.blueAccent, provider),
                const SizedBox(width: 14),
                _buildKanbanColumn('In Progress', inProgress, Colors.orangeAccent, provider),
                const SizedBox(width: 14),
                _buildKanbanColumn('Done', done, Colors.greenAccent, provider),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildKanbanColumn(String title, List<dynamic> columnTasks, Color themeColor, SSHProvider provider) {
    return Expanded(
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0xFF0F172A),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppPalette.border),
        ),
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(width: 10, height: 10, decoration: BoxDecoration(color: themeColor, shape: BoxShape.circle)),
                const SizedBox(width: 8),
                Text(title, style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 15)),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(color: AppPalette.backgroundDeep, borderRadius: BorderRadius.circular(12)),
                  child: Text('${columnTasks.length}', style: const TextStyle(fontSize: 12)),
                ),
              ],
            ),
            const Divider(height: 20),
            Expanded(
              child: columnTasks.isEmpty
                  ? Center(child: Text('No tasks', style: TextStyle(color: AppPalette.textMuted, fontSize: 13)))
                  : ListView.builder(
                      itemCount: columnTasks.length,
                      itemBuilder: (context, index) {
                        final task = columnTasks[index];
                        return Card(
                          color: AppPalette.surface,
                          margin: const EdgeInsets.only(bottom: 10),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                            side: BorderSide(color: AppPalette.border),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        task.title ?? 'Untitled Task',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    if (task.status == 'running')
                                      const SizedBox(
                                        width: 12,
                                        height: 12,
                                        child: CircularProgressIndicator(strokeWidth: 1.5, color: Colors.orangeAccent),
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  task.command ?? '',
                                  style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppPalette.textSecondary),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 8),
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.end,
                                  children: [
                                    if (task.status == 'running')
                                      TextButton.icon(
                                        onPressed: () => provider.cancelTask(task),
                                        icon: Icon(Icons.cancel, size: 14, color: AppPalette.danger),
                                        label: Text('Kill', style: TextStyle(fontSize: 11, color: AppPalette.danger)),
                                        style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(50, 30)),
                                      )
                                    else if (task.status == 'pending' || task.status == 'draft')
                                      FilledButton.icon(
                                        onPressed: () => provider.launchTask(task),
                                        icon: const Icon(Icons.play_arrow, size: 14, color: Colors.greenAccent),
                                        label: const Text('Run', style: TextStyle(fontSize: 11, color: Colors.greenAccent)),
                                        style: FilledButton.styleFrom(
                                          backgroundColor: Colors.greenAccent.withOpacity(0.1),
                                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                          minimumSize: const Size(60, 30),
                                        ),
                                      ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSoulPersonaEditor() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Left Sidebar: Files & Categories
        Container(
          width: 250,
          decoration: BoxDecoration(
            border: Border(right: BorderSide(color: AppPalette.border)),
            color: AppPalette.backgroundDeep,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  'Memory & Knowledge',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                        color: AppPalette.textPrimary,
                      ),
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  children: [
                    _buildSidebarSectionHeader('Agent Core'),
                    _buildSidebarItem(
                      icon: Icons.psychology,
                      label: 'SOUL.md',
                      isSelected: _activeMemoryFile == 'soul',
                      onTap: () => _selectMemoryFile('soul'),
                    ),
                    const SizedBox(height: 12),
                    _buildSidebarSectionHeader('Compact Memories'),
                    _buildSidebarItem(
                      icon: Icons.folder_shared_outlined,
                      label: 'Project Memory',
                      sublabel: '${memoryStore.profile}/${memoryStore.project}',
                      isSelected: _activeMemoryFile == 'project_memory',
                      onTap: () => _selectMemoryFile('project_memory'),
                    ),
                    _buildSidebarItem(
                      icon: Icons.psychology_alt,
                      label: 'General Memory',
                      sublabel: 'global memories',
                      isSelected: _activeMemoryFile == 'general_memory',
                      onTap: () => _selectMemoryFile('general_memory'),
                    ),
                    _buildSidebarItem(
                      icon: Icons.person_outline,
                      label: 'User Profile',
                      sublabel: 'user habits',
                      isSelected: _activeMemoryFile == 'user_profile',
                      onTap: () => _selectMemoryFile('user_profile'),
                    ),
                    const SizedBox(height: 12),
                    _buildSidebarSectionHeader(
                      'Obsidian Knowledge Base',
                      trailing: IconButton(
                        icon: Icon(Icons.add, size: 16, color: AppPalette.accent),
                        onPressed: _createNewKbFile,
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(),
                        tooltip: 'Add new doc',
                      ),
                    ),
                    if (_kbFiles.isEmpty)
                      Padding(
                        padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                        child: Text(
                          'No documents yet.',
                          style: TextStyle(fontSize: 11, color: AppPalette.textMuted),
                        ),
                      )
                    else
                      ..._kbFiles.map((file) {
                        final name = file.uri.pathSegments.last;
                        final isSelected = _activeMemoryFile == 'kb/$name';
                        return _buildSidebarItem(
                          icon: Icons.article_outlined,
                          label: name,
                          isSelected: isSelected,
                          onTap: () => _selectMemoryFile('kb/$name'),
                          trailing: IconButton(
                            icon: Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                            onPressed: () => _deleteKbFile(name),
                            padding: EdgeInsets.zero,
                            constraints: const BoxConstraints(),
                            tooltip: 'Delete doc',
                          ),
                        );
                      }),
                  ],
                ),
              ),
            ],
          ),
        ),

        // Right Main Panel: Editor or Memory List
        Expanded(
          child: Container(
            color: AppPalette.background,
            child: _buildMemoryActivePanel(),
          ),
        ),
      ],
    );
  }

  Widget _buildSidebarSectionHeader(String title, {Widget? trailing}) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.bold,
              color: AppPalette.textMuted,
              letterSpacing: 1.1,
            ),
          ),
          if (trailing != null) trailing,
        ],
      ),
    );
  }

  Widget _buildSidebarItem({
    required IconData icon,
    required String label,
    String? sublabel,
    required bool isSelected,
    required VoidCallback onTap,
    Widget? trailing,
  }) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          decoration: BoxDecoration(
            color: isSelected ? AppPalette.surfaceSoft : Colors.transparent,
            border: isSelected
                ? Border(left: BorderSide(color: AppPalette.accent, width: 3))
                : null,
          ),
          child: Row(
            children: [
              Icon(icon, size: 16, color: isSelected ? AppPalette.accent : AppPalette.textSecondary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                        color: isSelected ? AppPalette.textPrimary : AppPalette.textSecondary,
                      ),
                    ),
                    if (sublabel != null)
                      Text(
                        sublabel,
                        style: TextStyle(fontSize: 9, color: AppPalette.textMuted),
                      ),
                  ],
                ),
              ),
              if (trailing != null) trailing,
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMemoryActivePanel() {
    final isSoul = _activeMemoryFile == 'soul';
    final isKb = _activeMemoryFile.startsWith('kb/');

    if (isSoul || isKb) {
      final controller = isSoul ? soulController : _kbFileContentController;
      final title = isSoul ? 'SOUL.md Persona' : _selectedKbFileName ?? 'Doc';
      final description = isSoul
          ? 'SOUL.md dictates the AI\'s persona, guidelines, safety parameters, and tool execution boundaries.'
          : 'Project Obsidian Knowledge Base Document';

      return Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.description_outlined, color: AppPalette.accent, size: 22),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w900,
                              color: AppPalette.textPrimary,
                            ),
                      ),
                      Text(
                        description,
                        style: TextStyle(fontSize: 11, color: AppPalette.textMuted),
                      ),
                    ],
                  ),
                ),
                FilledButton.icon(
                  onPressed: isSoul ? () async {
                    await _saveHermesSettings();
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('SOUL Persona operating policy updated.')));
                  } : _saveActiveKbFile,
                  icon: const Icon(Icons.save, size: 16),
                  label: const Text('Save Document'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Editor
                  Expanded(
                    child: Container(
                      decoration: BoxDecoration(
                        border: Border.all(color: AppPalette.border),
                        borderRadius: BorderRadius.circular(12),
                        color: AppPalette.surface,
                      ),
                      child: TextField(
                        controller: controller,
                        maxLines: null,
                        expands: true,
                        onChanged: (_) => setState(() {}),
                        style: TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.4, color: AppPalette.textPrimary),
                        decoration: const InputDecoration(
                          hintText: 'Start writing markdown...',
                          border: InputBorder.none,
                          contentPadding: EdgeInsets.all(14),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  // Markdown Preview
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppPalette.backgroundDeep,
                        border: Border.all(color: AppPalette.border),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Live Markdown Preview',
                            style: Theme.of(context).textTheme.labelLarge?.copyWith(
                                  color: AppPalette.accent,
                                  fontWeight: FontWeight.bold,
                                ),
                          ),
                          const Divider(),
                          Expanded(
                            child: SingleChildScrollView(
                              child: _HermesMarkdownContent(data: controller.text),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    // Otherwise, show compact memories manager
    final String target = _activeMemoryFile == 'project_memory'
        ? 'memory'
        : (_activeMemoryFile == 'general_memory' ? 'general' : 'user');
    final String displayTitle = target == 'user'
        ? 'User Profile Memory'
        : (target == 'general' ? 'General Memory' : 'Project Memory');

    return FutureBuilder<HermesMemorySnapshot>(
      future: memoryStore.loadSnapshot(),
      builder: (context, snapshot) {
        final data = snapshot.data;
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (data == null) {
          return const Center(child: Text('Failed to load memory state.'));
        }

        final targetState = data.target(target);
        final usageColor = targetState.usedChars > targetState.limit
            ? AppPalette.danger
            : targetState.isNearCapacity
                ? AppPalette.warning
                : AppPalette.success;

        return Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    target == 'user' ? Icons.person_outline : Icons.psychology,
                    color: AppPalette.accent,
                    size: 22,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          displayTitle,
                          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                                fontWeight: FontWeight.w900,
                                color: AppPalette.textPrimary,
                              ),
                        ),
                        Text(
                          target == 'user'
                              ? 'USER.md: Stores user preferences, workflow habits, and communication rules.'
                              : (target == 'general'
                                  ? 'general/MEMORY.md: Stores global facts and conventions shared across all projects.'
                                  : 'projects/${memoryStore.profile}/${memoryStore.project}/MEMORY.md: Stores project-specific context and status.'),
                          style: TextStyle(fontSize: 11, color: AppPalette.textMuted),
                        ),
                      ],
                    ),
                  ),
                  FilledButton.icon(
                    onPressed: () => _showMemoryEditor(target: target),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('Add Memory Entry'),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // Progress Capacity Bar
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppPalette.surface,
                  border: Border.all(color: AppPalette.border),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'LLM Prompt Injection Budget',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
                        ),
                        Text(
                          '${targetState.usedChars} / ${targetState.limit} chars (${targetState.percent}%)',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: usageColor),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: LinearProgressIndicator(
                        value: (targetState.usedChars / targetState.limit).clamp(0.0, 1.0),
                        backgroundColor: AppPalette.border,
                        color: usageColor,
                        minHeight: 6,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // List of entries
              Expanded(
                child: targetState.entries.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.notes, size: 48, color: AppPalette.textMuted.withOpacity(0.3)),
                            const SizedBox(height: 10),
                            Text(
                              'No memory entries recorded yet.',
                              style: TextStyle(color: AppPalette.textMuted),
                            ),
                          ],
                        ),
                      )
                    : GridView.builder(
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          crossAxisSpacing: 12,
                          mainAxisSpacing: 12,
                          childAspectRatio: 2.2,
                        ),
                        itemCount: targetState.entries.length,
                        itemBuilder: (context, index) {
                          final entry = targetState.entries[index];
                          return Card(
                            margin: EdgeInsets.zero,
                            color: AppPalette.surface,
                            elevation: 0,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                              side: BorderSide(color: AppPalette.border),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: SingleChildScrollView(
                                      child: SelectableText(
                                        entry,
                                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                              height: 1.35,
                                              color: AppPalette.textPrimary,
                                            ),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      IconButton(
                                        icon: Icon(Icons.edit, size: 14, color: AppPalette.textSecondary),
                                        onPressed: () => _showMemoryEditor(target: target, oldText: entry),
                                        padding: EdgeInsets.zero,
                                        constraints: const BoxConstraints(),
                                        tooltip: 'Edit entry',
                                      ),
                                      const SizedBox(width: 12),
                                      IconButton(
                                        icon: Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                                        onPressed: () => _removeMemoryEntry(target: target, oldText: entry),
                                        padding: EdgeInsets.zero,
                                        constraints: const BoxConstraints(),
                                        tooltip: 'Delete entry',
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildGateway(SSHProvider provider) {
    final tools = [
      ('memory', 'implemented', 'Hermes built-in memory semantics: add/replace/remove in MEMORY.md / USER.md.'),
      ('dashboard.context', 'implemented', 'Read active profile/project/host/task metadata.'),
      ('gpu.snapshot', 'implemented', 'Read live GPU metrics from the dashboard provider.'),
      ('task.list', 'implemented', 'Read tracked dashboard tasks.'),
      ('file.list / file.read_text', 'implemented', 'Read-only remote file inspection through SSH.'),
      ('file.write_text', 'approval', 'Approval-gated remote text write.'),
      ('ssh.run_readonly', 'guarded', 'Only narrow read-only commands are auto-approved.'),
      ('ssh.run_approved', 'approval', 'Approval-gated mutating shell command.'),
      ('remote.bootstrap', 'implemented', 'Installs/checks ~/.ssh_dashboard lightweight remote runtime.'),
      ('remote.tmux.list / capture', 'implemented', 'Reconnect to persistent remote tmux sessions.'),
      ('remote.tmux.start / send / stop', 'guarded', 'Persistent remote session control for tmux mode.'),
      ('skill.list / skill.read / skill.write', 'implemented', 'Markdown skills under hermes_home/skills.'),
      ('session.search', 'implemented', 'Search loaded persisted Hermes session messages.'),
    ];
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        _HermesPanel(
          title: 'Remote Runtime / Hermes Tool Gateway',
          icon: Icons.router,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Messaging gateways are intentionally removed. Remote Runtime now means SSH-installed ~/.ssh_dashboard tooling plus persistent tmux sessions controlled from this app. The Dart harness proposes tool calls, approval policy evaluates them, and observations are recorded in the session stream.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _HermesPill(icon: Icons.dns, label: 'Host: ${provider.connectedHost ?? '-'}'),
                  _HermesPill(icon: Icons.folder, label: 'PWD: ${provider.sharedPwd}'),
                  _HermesPill(icon: Icons.memory, label: 'GPU tools: ${provider.gpus.length} GPU(s)'),
                  _HermesPill(icon: Icons.security, label: allowRemoteTools ? 'Remote tools enabled' : 'Remote tools disabled'),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        ...tools.map((tool) => Card(
              color: const Color(0xFF111827),
              child: ListTile(
                leading: Icon(
                  tool.$2 == 'implemented' ? Icons.check_circle : tool.$2 == 'guarded' ? Icons.shield : tool.$2 == 'approval' ? Icons.verified_user : Icons.block,
                  color: tool.$2 == 'implemented' ? Colors.greenAccent : tool.$2 == 'guarded' ? Colors.orangeAccent : tool.$2 == 'approval' ? AppPalette.accent : Colors.redAccent,
                ),
                title: Text(tool.$1, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
                subtitle: Text(tool.$3, style: const TextStyle(fontSize: 12)),
                trailing: Text(tool.$2, style: const TextStyle(fontSize: 11)),
              ),
            )),
      ],
    );
  }

  Widget _buildSecurity() {
    return ListView(
      padding: const EdgeInsets.all(18),
      children: const [
        _HermesPanel(
          title: 'Security baseline',
          icon: Icons.security,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _HermesCheckLine(text: 'No external Hermes process, WSL, Docker, Python, Node, Git, or bundled sidecar is launched.'),
              _HermesCheckLine(text: 'Google AI Studio API key is isolated as a dedicated Flutter secure-storage secret.'),
              _HermesCheckLine(text: 'Model/base URL/profile/project settings are stored in local JSON without apiKey.'),
              _HermesCheckLine(text: 'Read-only dashboard tools can be auto-approved; mutating tools present user-facing approval actions.'),
              _HermesCheckLine(text: 'The model cannot execute shell commands directly; it can only request registered tools.'),
              _HermesCheckLine(text: 'Memory writes go through the bounded Hermes memory tool and are scanned before being persisted.'),
            ],
          ),
        ),
      ],
    );
  }

  List<Map<String, String>> get _allSlashCommands {
    final list = <Map<String, String>>[
      {'cmd': '/new', 'desc': 'Start a new conversation session'},
      {'cmd': '/reset', 'desc': 'Reset conversation session'},
      {'cmd': '/clear', 'desc': 'Clear session and start a new one'},
      {'cmd': '/quit', 'desc': 'Exit active session and go to overview'},
      {'cmd': '/exit', 'desc': 'Exit active session and go to overview'},
      {'cmd': '/help', 'desc': 'Show all commands and guides'},
      {'cmd': '/version', 'desc': 'Show application version and environment info'},
      {'cmd': '/usage', 'desc': 'Show token usage and session stats'},
      {'cmd': '/insights', 'desc': 'Display usage analytics and insights'},
      {'cmd': '/profile', 'desc': 'Display active profile and home directory'},
      {'cmd': '/debug', 'desc': 'Generate and show debug report'},
      {'cmd': '/paste', 'desc': 'Attach an image from clipboard'},
      {'cmd': '/copy', 'desc': 'Copy the last assistant response to clipboard'},
      {'cmd': '/skills', 'desc': 'Browse and manage Skills Hub'},
      {'cmd': '/memory', 'desc': 'Navigate to SOUL Persona'},
      {'cmd': '/tasks', 'desc': 'Navigate to Tasks Kanban'},
      {'cmd': '/settings', 'desc': 'Open System Settings'},
      {'cmd': '/resume', 'desc': 'Select a past session to resume'},
    ];
    for (final file in _localSkills) {
      final name = file.path.split(io.Platform.isWindows ? '\\' : '/').last.replaceAll('.md', '');
      list.add({
        'cmd': '/$name',
        'desc': 'Run custom skill: $name',
      });
    }
    return list;
  }

  bool _handleArrowUp(bool forceHistory) {
    final text = inputController.text;
    final isSlash = text.startsWith('/');
    final suggestions = isSlash
        ? _allSlashCommands.where((c) => c['cmd']!.startsWith(text.toLowerCase())).toList()
        : const <Map<String, String>>[];

    if (isSlash && suggestions.isNotEmpty) {
      setState(() {
        _selectedSuggestionIndex = (_selectedSuggestionIndex - 1 + suggestions.length) % suggestions.length;
      });
      return true;
    }

    final choices = _extractSessionChoices();
    if (!forceHistory && text.isEmpty && choices.isNotEmpty) {
      setState(() {
        if (_selectedChoiceIndex == -1) {
          _selectedChoiceIndex = choices.length - 1;
        } else {
          _selectedChoiceIndex = (_selectedChoiceIndex - 1 + choices.length) % choices.length;
        }
      });
      return true;
    }

    if (_inputHistory.isNotEmpty) {
      if (_historyIndex == -1) {
        _composerDraft = inputController.text;
        _historyIndex = _inputHistory.length - 1;
      } else if (_historyIndex > 0) {
        _historyIndex--;
      }
      setState(() {
        inputController.text = _inputHistory[_historyIndex];
        inputController.selection = TextSelection.collapsed(offset: inputController.text.length);
      });
      return true;
    }

    return false;
  }

  bool _handleArrowDown(bool forceHistory) {
    final text = inputController.text;
    final isSlash = text.startsWith('/');
    final suggestions = isSlash
        ? _allSlashCommands.where((c) => c['cmd']!.startsWith(text.toLowerCase())).toList()
        : const <Map<String, String>>[];

    if (isSlash && suggestions.isNotEmpty) {
      setState(() {
        _selectedSuggestionIndex = (_selectedSuggestionIndex + 1) % suggestions.length;
      });
      return true;
    }

    final choices = _extractSessionChoices();
    if (!forceHistory && text.isEmpty && choices.isNotEmpty) {
      setState(() {
        if (_selectedChoiceIndex == -1) {
          _selectedChoiceIndex = 0;
        } else {
          _selectedChoiceIndex = (_selectedChoiceIndex + 1) % choices.length;
        }
      });
      return true;
    }

    if (_historyIndex != -1) {
      if (_historyIndex < _inputHistory.length - 1) {
        _historyIndex++;
        setState(() {
          inputController.text = _inputHistory[_historyIndex];
          inputController.selection = TextSelection.collapsed(offset: inputController.text.length);
        });
      } else {
        _historyIndex = -1;
        setState(() {
          inputController.text = _composerDraft;
          inputController.selection = TextSelection.collapsed(offset: inputController.text.length);
        });
      }
      return true;
    }

    return false;
  }

  bool _handleEnter() {
    final text = inputController.text.trim();
    final isSlash = text.startsWith('/');
    final suggestions = isSlash
        ? _allSlashCommands.where((c) => c['cmd']!.startsWith(text.toLowerCase())).toList()
        : const <Map<String, String>>[];

    if (isSlash) {
      final cmd = text.split(' ').first.toLowerCase();
      final hasExactMatch = _allSlashCommands.any((c) => c['cmd']!.toLowerCase() == cmd);

      if (hasExactMatch) {
        unawaited(_runTurn(context.read<SSHProvider>()));
        return true;
      }

      if (suggestions.isNotEmpty) {
        final chosen = suggestions[_selectedSuggestionIndex]['cmd']!;
        setState(() {
          inputController.text = chosen;
          inputController.selection = TextSelection.collapsed(offset: chosen.length);
          _selectedSuggestionIndex = 0;
        });
        return true;
      }
    }

    final choices = _extractSessionChoices();
    if (choices.isNotEmpty && _selectedChoiceIndex != -1 && _selectedChoiceIndex < choices.length) {
      final chosenChoice = choices[_selectedChoiceIndex];
      setState(() {
        _selectedChoiceIndex = -1;
      });
      final cleanText = _cleanChoiceForSending(chosenChoice);
      unawaited(_runTurn(context.read<SSHProvider>(), cleanText));
      return true;
    }

    if (inputController.text.trim().isNotEmpty) {
      unawaited(_runTurn(context.read<SSHProvider>()));
      return true;
    }

    return false;
  }

  String _cleanChoiceForSending(String choiceLine) {
    final numeric = RegExp(r'^(\d{1,2})[\.\)]').firstMatch(choiceLine);
    if (numeric != null) {
      return numeric.group(1) ?? choiceLine;
    }
    return choiceLine;
  }

  List<String> _extractSessionChoices() {
    if (visibleMessages.isEmpty) return [];
    final lastMsg = visibleMessages.last;
    if (lastMsg.role != 'assistant' && lastMsg.role != 'system') return [];

    // Look for a clarification part in the last message
    for (final part in lastMsg.parts) {
      if (part.type == 'clarification') {
        final optionsRaw = part.metadata['options'];
        if (optionsRaw is List) {
          return optionsRaw.map((e) => e.toString()).where((e) => e.trim().isNotEmpty).toList();
        }
      }
    }

    // Fallback: y/n check for explicit prompts
    final text = lastMsg.plainText.trim().toLowerCase();
    if (text.endsWith('[y/n]') || text.endsWith('y/n') || text.contains('\n[y/n]') || text.contains('\ny/n')) {
      return ['y', 'n'];
    }

    return [];
  }

  Widget _buildChoicesList(List<String> choices) {
    if (choices.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: AppPalette.surfaceSoft,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: EdgeInsets.only(left: 8, bottom: 4),
            child: Text(
              'SELECT OPTION (Use Arrow Keys + Enter):',
              style: TextStyle(color: AppPalette.accent, fontSize: 10, fontWeight: FontWeight.bold),
            ),
          ),
          ...choices.asMap().entries.map((entry) {
            final idx = entry.key;
            final choice = entry.value;
            final isSelected = _selectedChoiceIndex == idx;
            return Container(
              margin: const EdgeInsets.only(bottom: 2),
              decoration: BoxDecoration(
                color: isSelected ? AppPalette.accent.withOpacity(0.12) : Colors.transparent,
                border: isSelected
                    ? Border(left: BorderSide(color: AppPalette.accent, width: 3))
                    : null,
                borderRadius: BorderRadius.circular(4),
              ),
              child: ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                title: Text(
                  choice,
                  style: TextStyle(
                    fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                    color: isSelected ? AppPalette.accent : AppPalette.textSecondary,
                    fontSize: 12,
                  ),
                ),
                onTap: () {
                  setState(() {
                    _selectedChoiceIndex = idx;
                  });
                  final cleanText = _cleanChoiceForSending(choice);
                  unawaited(_runTurn(context.read<SSHProvider>(), cleanText));
                },
              ),
            );
          }),
        ],
      ),
    );
  }

  Future<void> _pasteImage() async {
    try {
      final tempDir = io.Directory.systemTemp;
      final scriptFile = io.File('${tempDir.path}/save_clipboard_image.ps1');
      await scriptFile.writeAsString(r'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
    $path = $args[0]
    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "SUCCESS"
} else {
    Write-Output "EMPTY"
}
''');

      final timestamp = DateTime.now().millisecondsSinceEpoch;
      final targetDir = io.Directory('${sessionStore._expandedHome(hermesHomeController.text.trim())}/scratch');
      if (!await targetDir.exists()) {
        await targetDir.create(recursive: true);
      }
      final targetPath = '${targetDir.path}/pasted_$timestamp.png';

      final result = await io.Process.run('powershell', [
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptFile.path,
        targetPath,
      ]);

      if (result.stdout.toString().contains('SUCCESS')) {
        final fileUrl = 'file:///${targetPath.replaceAll('\\', '/')}';
        final imageMarkdown = '![pasted_image]($fileUrl)';
        _insertIntoComposer(imageMarkdown);
        setState(() {
          lastStatus = 'Image pasted from clipboard successfully.';
        });
      } else {
        setState(() {
          lastStatus = 'No image found in clipboard.';
        });
      }
    } catch (e) {
      setState(() {
        lastStatus = 'Failed to paste image: $e';
      });
    }
  }

  Widget _buildQuickApiSwitcher(SSHProvider provider) {
    final activeProfile = apiProfiles.firstWhere(
      (p) => p.id == activeApiProfileId,
      orElse: () => const HermesApiProfile(
        id: 'default',
        name: 'Google AI Studio (Gemini)',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemma-4-26b-a4b-it',
        limitLabel: '15 RPM / 32k context',
      ),
    );

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppPalette.surfaceSoft,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.api_outlined, size: 14, color: AppPalette.accent),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  activeProfile.name,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    color: AppPalette.textPrimary,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              PopupMenuButton<String>(
                icon: Icon(Icons.swap_horiz, size: 16, color: AppPalette.textMuted),
                tooltip: 'Switch API Provider',
                padding: const EdgeInsets.all(4),
                constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                onSelected: (profileId) => _switchApiProfile(profileId),
                itemBuilder: (context) {
                  return apiProfiles.map((p) {
                    final isActive = p.id == activeApiProfileId;
                    return PopupMenuItem<String>(
                      value: p.id,
                      child: Row(
                        children: [
                          Icon(
                            isActive ? Icons.radio_button_checked : Icons.radio_button_off,
                            size: 14,
                            color: isActive ? AppPalette.accent : AppPalette.textMuted,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  p.name,
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
                                  ),
                                ),
                                Text(
                                  '${p.model} · ${p.limitLabel}',
                                  style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    );
                  }).toList();
                },
              ),
            ],
          ),
          const SizedBox(height: 6),
          PopupMenuButton<String>(
            tooltip: 'Switch Model',
            onSelected: (modelName) => _switchProfileModel(activeProfile.id, modelName),
            offset: const Offset(0, 32),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            color: AppPalette.surfaceElevated,
            itemBuilder: (context) {
              final models = activeProfile.supportedModels.isNotEmpty
                  ? activeProfile.supportedModels
                  : [activeProfile.model];
              return models.map((m) {
                final isCurrentModel = m == activeProfile.model;
                return PopupMenuItem<String>(
                  value: m,
                  child: Row(
                    children: [
                      if (isCurrentModel)
                        Icon(Icons.check, size: 14, color: AppPalette.accent)
                      else
                        const SizedBox(width: 14),
                      const SizedBox(width: 8),
                      Text(
                        m,
                        style: TextStyle(
                          fontSize: 11,
                          color: isCurrentModel ? AppPalette.accent : AppPalette.textPrimary,
                          fontWeight: isCurrentModel ? FontWeight.bold : FontWeight.normal,
                        ),
                      ),
                    ],
                  ),
                );
              }).toList();
            },
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
              decoration: BoxDecoration(
                color: AppPalette.surface,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: AppPalette.border),
              ),
              child: Row(
                children: [
                  Icon(Icons.psychology_outlined, size: 13, color: AppPalette.accent),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      activeProfile.model,
                      style: TextStyle(fontSize: 10, color: AppPalette.textPrimary, fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Icon(Icons.unfold_more, size: 14, color: AppPalette.textSecondary),
                ],
              ),
            ),
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: AppPalette.accent.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  activeProfile.limitLabel,
                  style: TextStyle(
                    fontSize: 9,
                    color: AppPalette.accent,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _switchApiProfile(String profileId) async {
    final profile = apiProfiles.firstWhere((p) => p.id == profileId);
    final apiKey = profileApiKeys[profile.id] ?? '';

    setState(() {
      activeApiProfileId = profileId;
      baseUrlController.text = profile.baseUrl;
      modelController.text = profile.model;
      apiKeyController.text = apiKey;
      lastStatus = 'Switched API Provider to: ${profile.name}';
    });

    await _saveHermesSettings();
  }

  Future<void> _switchProfileModel(String profileId, String modelName) async {
    setState(() {
      final idx = apiProfiles.indexWhere((p) => p.id == profileId);
      if (idx != -1) {
        apiProfiles[idx] = apiProfiles[idx].copyWith(model: modelName);
      }
      if (profileId == activeApiProfileId) {
        modelController.text = modelName;
      }
      lastStatus = 'Changed active model to $modelName for provider: ${apiProfiles.firstWhere((p) => p.id == profileId).name}';
    });

    await _saveHermesSettings();
  }

  Future<void> _testProfileConnection(HermesApiProfile profile) async {
    final apiKey = profileApiKeys[profile.id] ?? '';
    setState(() {
      lastStatus = 'Testing API Provider: ${profile.name}...';
    });

    try {
      final reply = await llmClient.generate(
        apiKey: apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        systemPrompt: 'Reply with "OK" if reachable.',
        userPrompt: 'Hello. Connection check.',
      );

      if (!mounted) return;
      setState(() {
        lastStatus = 'Connection test succeeded for ${profile.name}: $reply';
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Connection test succeeded: $reply')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        lastStatus = 'Connection test failed for ${profile.name}: $e';
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Connection test failed: $e'),
          backgroundColor: AppPalette.danger,
        ),
      );
    }
  }

  Future<void> _showApiProfileEditor([HermesApiProfile? profile]) async {
    final isEdit = profile != null;
    final nameController = TextEditingController(text: profile?.name ?? '');
    final baseUrlController = TextEditingController(text: profile?.baseUrl ?? '');
    final modelController = TextEditingController(text: profile?.model ?? '');
    final limitController = TextEditingController(text: profile?.limitLabel ?? '15 RPM / 32k context');
    final supportedModelsController = TextEditingController(
      text: profile != null ? profile.supportedModels.join(', ') : '',
    );
    final keyController = TextEditingController(text: profile != null ? (profileApiKeys[profile.id] ?? '') : '');
    bool isObscured = true;

    final result = await showDialog<bool>(
      context: context,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              title: Text(isEdit ? 'Edit API Provider: ${profile.name}' : 'Add Custom API Provider'),
              content: SizedBox(
                width: 500,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: nameController,
                        decoration: const InputDecoration(labelText: 'Provider Name', hintText: 'e.g. Local Llama', border: OutlineInputBorder(), isDense: true),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: baseUrlController,
                        decoration: const InputDecoration(labelText: 'Base URL', hintText: 'https://api.openai.com/v1', border: OutlineInputBorder(), isDense: true),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: modelController,
                        decoration: const InputDecoration(labelText: 'Active Model Name', hintText: 'gpt-4o', border: OutlineInputBorder(), isDense: true),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: supportedModelsController,
                        decoration: const InputDecoration(
                          labelText: 'Supported Models (comma separated)',
                          hintText: 'gemma-4-26b-a4b-it, gemini-1.5-pro',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: limitController,
                        decoration: const InputDecoration(labelText: 'Limits Label', hintText: 'e.g. 5hr limit / 60 RPM', border: OutlineInputBorder(), isDense: true),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: keyController,
                        obscureText: isObscured,
                        decoration: InputDecoration(
                          labelText: 'API Key (optional for local)',
                          border: const OutlineInputBorder(),
                          isDense: true,
                          suffixIcon: IconButton(
                            icon: Icon(isObscured ? Icons.visibility : Icons.visibility_off),
                            onPressed: () => setDialogState(() => isObscured = !isObscured),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
                FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Save')),
              ],
            );
          },
        );
      },
    );

    if (result == true) {
      final name = nameController.text.trim();
      final baseUrl = baseUrlController.text.trim();
      final model = modelController.text.trim();
      final limit = limitController.text.trim();
      final supportedRaw = supportedModelsController.text.trim();
      final key = keyController.text.trim();

      if (name.isEmpty || baseUrl.isEmpty || model.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Name, Base URL, and Model Name cannot be empty.')),
        );
        return;
      }

      final supported = supportedRaw.isNotEmpty
          ? supportedRaw.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList()
          : <String>[];

      // Ensure active model is in the supported models list
      if (supported.isNotEmpty && !supported.contains(model)) {
        supported.insert(0, model);
      }

      final id = isEdit ? profile.id : 'profile_${DateTime.now().millisecondsSinceEpoch}';
      final newProfile = HermesApiProfile(
        id: id,
        name: name,
        baseUrl: baseUrl,
        model: model,
        limitLabel: limit,
        supportedModels: supported,
      );

      setState(() {
        if (isEdit) {
          final idx = apiProfiles.indexWhere((p) => p.id == id);
          if (idx != -1) {
            apiProfiles[idx] = newProfile;
          }
        } else {
          apiProfiles.add(newProfile);
        }
        profileApiKeys[id] = key;
      });

      final secureProfileKey = 'ssh_dashboard_hermes_api_key_$id';
      if (key.isEmpty) {
        await _secureStorage.delete(key: secureProfileKey);
      } else {
        await _secureStorage.write(key: secureProfileKey, value: key);
      }

      if (id == activeApiProfileId) {
        setState(() {
          baseUrlController.text = baseUrl;
          modelController.text = model;
          apiKeyController.text = key;
        });
      }

      await _saveHermesSettings();
    }

    nameController.dispose();
    baseUrlController.dispose();
    modelController.dispose();
    limitController.dispose();
    supportedModelsController.dispose();
    keyController.dispose();
  }

  Future<void> _deleteApiProfile(String profileId) async {
    if (profileId == 'default') return;

    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete API Provider?'),
        content: const Text('Are you sure you want to delete this API provider configuration?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );

    if (ok != true) return;

    setState(() {
      apiProfiles.removeWhere((p) => p.id == profileId);
      profileApiKeys.remove(profileId);
      if (activeApiProfileId == profileId) {
        activeApiProfileId = 'default';
        final defProfile = apiProfiles.firstWhere((p) => p.id == 'default');
        baseUrlController.text = defProfile.baseUrl;
        modelController.text = defProfile.model;
        apiKeyController.text = profileApiKeys['default'] ?? '';
      }
    });

    await _secureStorage.delete(key: 'ssh_dashboard_hermes_api_key_$profileId');
    await _saveHermesSettings();
  }

  Widget _buildApiProfilesGrid() {
    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.api, color: AppPalette.accent, size: 24),
              const SizedBox(width: 10),
              Text('API Providers', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
              const Spacer(),
              FilledButton.icon(
                onPressed: () => _showApiProfileEditor(),
                icon: const Icon(Icons.add),
                label: const Text('Add API Provider'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'Configure different LLM backends (Google AI Studio, OpenAI, Ollama, DeepSeek, etc.). Switch providers instantly to bypass rate limits or switch to local models when offline.',
            style: TextStyle(color: AppPalette.textMuted, fontSize: 13),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: GridView.builder(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                maxCrossAxisExtent: 360,
                childAspectRatio: 1.35,
                crossAxisSpacing: 14,
                mainAxisSpacing: 14,
              ),
              itemCount: apiProfiles.length,
              itemBuilder: (context, index) {
                final profile = apiProfiles[index];
                final isActive = profile.id == activeApiProfileId;

                return Card(
                  color: AppPalette.surface,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(
                      color: isActive ? AppPalette.accent : AppPalette.border,
                      width: isActive ? 2 : 1,
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.cloud_queue, color: AppPalette.accent, size: 18),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                profile.name,
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (isActive)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  color: Colors.greenAccent.withOpacity(0.12),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: Colors.greenAccent, width: 0.5),
                                ),
                                child: const Text(
                                  'ACTIVE',
                                  style: TextStyle(color: Colors.greenAccent, fontSize: 9, fontWeight: FontWeight.bold),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        PopupMenuButton<String>(
                          tooltip: 'Select Model',
                          onSelected: (modelName) => _switchProfileModel(profile.id, modelName),
                          offset: const Offset(0, 36),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          color: AppPalette.surfaceElevated,
                          itemBuilder: (context) {
                            final models = profile.supportedModels.isNotEmpty
                                ? profile.supportedModels
                                : [profile.model];
                            return models.map((m) {
                              final isCurrent = m == profile.model;
                              return PopupMenuItem<String>(
                                value: m,
                                child: Row(
                                  children: [
                                    if (isCurrent)
                                      Icon(Icons.check, size: 14, color: AppPalette.accent)
                                    else
                                      const SizedBox(width: 14),
                                    const SizedBox(width: 8),
                                    Text(
                                      m,
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: isCurrent ? AppPalette.accent : AppPalette.textPrimary,
                                        fontWeight: isCurrent ? FontWeight.bold : FontWeight.normal,
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            }).toList();
                          },
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                            decoration: BoxDecoration(
                              color: AppPalette.surface,
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: AppPalette.border),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  'Model: ',
                                  style: TextStyle(fontSize: 10, color: AppPalette.textSecondary),
                                ),
                                Flexible(
                                  child: Text(
                                    profile.model,
                                    style: TextStyle(fontSize: 10, color: AppPalette.textPrimary, fontWeight: FontWeight.bold),
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                                const SizedBox(width: 4),
                                Icon(Icons.unfold_more, size: 14, color: AppPalette.textSecondary),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'URL: ${profile.baseUrl}',
                          style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppPalette.accent.withOpacity(0.08),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                profile.limitLabel,
                                style: TextStyle(fontSize: 10, color: AppPalette.accent, fontWeight: FontWeight.bold),
                              ),
                            ),
                          ],
                        ),
                        const Spacer(),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            TextButton(
                              onPressed: () => _testProfileConnection(profile),
                              child: const Text('Test', style: TextStyle(fontSize: 11)),
                            ),
                            if (!isActive)
                              TextButton(
                                onPressed: () => _switchApiProfile(profile.id),
                                child: const Text('Activate', style: TextStyle(fontSize: 11)),
                              ),
                            IconButton(
                              icon: const Icon(Icons.edit, size: 14),
                              onPressed: () => _showApiProfileEditor(profile),
                              tooltip: 'Edit',
                            ),
                            if (profile.id != 'default')
                              IconButton(
                                icon: Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                                onPressed: () => _deleteApiProfile(profile.id),
                                tooltip: 'Delete',
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _AgentStepData {
  final String tool;
  final Map<String, dynamic> args;
  final String reason;
  final DateTime timestamp;
  bool? ok;
  String? output;
  DateTime? completedAt;

  _AgentStepData({
    required this.tool,
    required this.args,
    required this.reason,
    required this.timestamp,
    this.ok,
    this.output,
    this.completedAt,
  });
}

class _AgentConsoleStatusDot extends StatefulWidget {
  final bool active;
  const _AgentConsoleStatusDot({required this.active});

  @override
  State<_AgentConsoleStatusDot> createState() => _AgentConsoleStatusDotState();
}

class _AgentConsoleStatusDotState extends State<_AgentConsoleStatusDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    );
    if (widget.active) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(covariant _AgentConsoleStatusDot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat(reverse: true);
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final opacity = widget.active ? (0.3 + 0.7 * _controller.value) : 1.0;
        final color = widget.active ? AppPalette.success : AppPalette.textMuted.withOpacity(0.5);
        return Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withOpacity(opacity),
            boxShadow: widget.active
                ? [
                    BoxShadow(
                      color: AppPalette.success.withOpacity(0.4 * _controller.value),
                      blurRadius: 6,
                      spreadRadius: 2,
                    )
                  ]
                : null,
          ),
        );
      },
    );
  }
}

