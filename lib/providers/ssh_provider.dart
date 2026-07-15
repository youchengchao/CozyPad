part of cozypad;

/* =========================================================
   Provider / SSH Logic
========================================================= */

class SSHProvider extends ChangeNotifier {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  static const String _profilesKey = 'connection_profiles';

  SSHClient? _client;
  SSHClient? get client => _client;

  Timer? _pollingTimer;

  bool isConnecting = false;
  bool isConnected = false;
  bool isPolling = false;
  bool credentialsLoaded = false;

  String? errorMessage;
  String? connectedHost;
  DateTime? lastUpdated;

  SavedCredentials? savedCredentials;

  CpuMetric cpu = CpuMetric.empty();
  MemoryMetric memory = MemoryMetric.empty();
  List<GpuMetric> gpus = [];
  List<TaskItem> tasks = [];
  bool isTaskQueueBusy = false;
  final Map<int, DateTime> _gpuIdleSince = {};

  String commandText = '';
  String commandOutput = '';
  bool isRunningCommand = false;

  String sharedPwd = '~';

  List<ConnectionProfile> connections = [];
  List<ConnectionProfile> get profiles => connections; // Backward compatibility
  bool profilesLoaded = false;

  List<ProjectProfile> projects = [];
  bool projectsLoaded = false;

  ConnectionProfile? activeConnection;
  ProjectProfile? activeProject;

  void selectProject(ProjectProfile? project) {
    activeProject = project;
    notifyListeners();
  }

  void selectConnection(ConnectionProfile? connection) {
    activeConnection = connection;
    notifyListeners();
  }

  // Hidden PTY agent session state.
  SSHSession? _agentSession;
  StreamSubscription<Uint8List>? _agentStdoutSub;
  StreamSubscription<Uint8List>? _agentStderrSub;
  Terminal? _hiddenAgentTerminal;

  bool isAgentSessionStarting = false;
  bool isAgentSessionReady = false;
  bool isAgentStreaming = false;

  String activeAgentName = 'Codex';
  String activeAgentCommand = 'codex';

  String agentDraft = '';
  String agentScreenText = '';
  List<AgentMessage> agentMessages = [];
  List<AgentSuggestion> agentSuggestions = [];

  Timer? _agentIdleTimer;
  String _lastAssistantScreenText = '';

  /* ---------------- Profile & Project Storage ---------------- */

  static const String _projectsKey = 'project_profiles';

  Future<void> loadProfiles() async {
    if (profilesLoaded && projectsLoaded) return;

    // 1. Load Connections
    if (!profilesLoaded) {
      final raw = await _storage.read(key: _profilesKey);

      if (raw != null && raw.isNotEmpty) {
        try {
          final decoded = jsonDecode(raw);
          if (decoded is List) {
            connections = decoded
                .map((e) =>
                    ConnectionProfile.fromJson(Map<String, dynamic>.from(e)))
                .toList();
          }
        } catch (_) {
          connections = [];
        }
      }
      profilesLoaded = true;
    }

    // 2. Load Projects
    if (!projectsLoaded) {
      final rawProj = await _storage.read(key: _projectsKey);
      if (rawProj != null && rawProj.isNotEmpty) {
        try {
          final decoded = jsonDecode(rawProj);
          if (decoded is List) {
            projects = decoded
                .map((e) =>
                    ProjectProfile.fromJson(Map<String, dynamic>.from(e)))
                .toList();
          }
        } catch (_) {
          projects = [];
        }
      }

      // Clean up any previously auto-migrated projects to keep a clean project list as expected
      final beforeCount = projects.length;
      projects.removeWhere((proj) => proj.description.startsWith('Auto-migrated from connection'));
      if (projects.length != beforeCount) {
        await saveProjects();
      }
      projectsLoaded = true;
    }

    notifyListeners();
  }

  Future<void> _persistProfiles() async {
    final raw = jsonEncode(connections.map((e) => e.toJson()).toList());
    await _storage.write(key: _profilesKey, value: raw);
  }

  Future<void> saveProjects() async {
    final raw = jsonEncode(projects.map((e) => e.toJson()).toList());
    await _storage.write(key: _projectsKey, value: raw);
  }

  Future<void> upsertProfile(ConnectionProfile profile) async {
    final normalized = profile.copyWith(
      name: profile.name.trim().isEmpty ? profile.host : profile.name.trim(),
      host: profile.host.trim(),
      username: profile.username.trim(),
    );

    if (normalized.autoLogin) {
      connections = connections.map((e) => e.copyWith(autoLogin: false)).toList();
    }

    final index = connections.indexWhere((e) => e.id == normalized.id);
    if (index >= 0) {
      connections[index] = normalized;
    } else {
      connections.add(normalized);
    }

    await _persistProfiles();
    notifyListeners();
  }

  Future<void> deleteProfile(String id) async {
    connections.removeWhere((e) => e.id == id);
    if (activeConnection?.id == id) {
      activeConnection = null;
    }
    await _persistProfiles();
    notifyListeners();
  }

  Future<void> upsertProject(ProjectProfile project) async {
    final index = projects.indexWhere((e) => e.id == project.id);
    if (index >= 0) {
      projects[index] = project;
    } else {
      projects.add(project);
    }
    await saveProjects();
    notifyListeners();
  }

  Future<void> deleteProject(String id) async {
    projects.removeWhere((e) => e.id == id);
    if (activeProject?.id == id) {
      activeProject = null;
    }
    await saveProjects();
    notifyListeners();
  }

  Future<void> updateProjectCodebaseState(
    String projectId,
    String connectionId,
    String remotePath, {
    String? codebaseUpdatedAt,
    bool isSync = false,
  }) async {
    final index = projects.indexWhere((e) => e.id == projectId);
    if (index < 0) return;

    final project = projects[index];
    final nowStr = DateTime.now().toIso8601String();

    final existingState = project.codebaseStates[connectionId];
    final newState = ProjectCodebaseState(
      connectionId: connectionId,
      remotePath: remotePath,
      lastActiveAt: nowStr,
      lastSyncAt: isSync ? nowStr : (existingState?.lastSyncAt ?? ''),
      codebaseUpdatedAt: codebaseUpdatedAt ?? (existingState?.codebaseUpdatedAt ?? nowStr),
    );

    final updatedStates = Map<String, ProjectCodebaseState>.from(project.codebaseStates);
    updatedStates[connectionId] = newState;

    final updatedProject = project.copyWith(codebaseStates: updatedStates);
    projects[index] = updatedProject;

    if (activeProject?.id == projectId) {
      activeProject = updatedProject;
    }

    await saveProjects();
    notifyListeners();
  }

  Future<void> recordProjectTransfer(
    String projectId, {
    String? fromConnectionId,
    required String toConnectionId,
    required String fromPath,
    required String toPath,
  }) async {
    final index = projects.indexWhere((e) => e.id == projectId);
    if (index < 0) return;

    final project = projects[index];
    final nowStr = DateTime.now().toIso8601String();

    final newRecord = ProjectTransferRecord(
      fromConnectionId: fromConnectionId,
      toConnectionId: toConnectionId,
      fromPath: fromPath,
      toPath: toPath,
      timestamp: nowStr,
    );

    final updatedHistory = List<ProjectTransferRecord>.from(project.transferHistory)..add(newRecord);

    final updatedStates = Map<String, ProjectCodebaseState>.from(project.codebaseStates);
    updatedStates[toConnectionId] = ProjectCodebaseState(
      connectionId: toConnectionId,
      remotePath: toPath,
      lastActiveAt: nowStr,
      lastSyncAt: nowStr,
      codebaseUpdatedAt: nowStr,
    );

    final updatedProject = project.copyWith(
      transferHistory: updatedHistory,
      codebaseStates: updatedStates,
    );

    projects[index] = updatedProject;
    if (activeProject?.id == projectId) {
      activeProject = updatedProject;
    }

    await saveProjects();
    notifyListeners();
  }

  ConnectionProfile? get autoLoginProfile {
    for (final profile in connections) {
      if (profile.autoLogin) return profile;
    }
    return null;
  }


  Future<void> connectWithProfile(ConnectionProfile profile) async {
    await connect(
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.password,
      remember: false,
      autoLogin: profile.autoLogin,
    );
  }

  /* ---------------- Legacy single credential storage ---------------- */

  Future<void> loadSavedCredentials() async {
    if (credentialsLoaded) return;

    final host = await _storage.read(key: 'host');
    final portText = await _storage.read(key: 'port');
    final username = await _storage.read(key: 'username');
    final password = await _storage.read(key: 'password');
    final autoLoginText = await _storage.read(key: 'autoLogin');

    if (host != null &&
        host.isNotEmpty &&
        username != null &&
        username.isNotEmpty &&
        password != null &&
        password.isNotEmpty) {
      savedCredentials = SavedCredentials(
        host: host,
        port: int.tryParse(portText ?? '22') ?? 22,
        username: username,
        password: password,
        autoLogin: autoLoginText == 'true',
      );
    }

    credentialsLoaded = true;
    notifyListeners();
  }

  Future<void> saveCredentials({
    required String host,
    required int port,
    required String username,
    required String password,
    required bool autoLogin,
  }) async {
    await _storage.write(key: 'host', value: host);
    await _storage.write(key: 'port', value: port.toString());
    await _storage.write(key: 'username', value: username);
    await _storage.write(key: 'password', value: password);
    await _storage.write(key: 'autoLogin', value: autoLogin.toString());

    savedCredentials = SavedCredentials(
      host: host,
      port: port,
      username: username,
      password: password,
      autoLogin: autoLogin,
    );
  }

  Future<void> clearSavedCredentials() async {
    await _storage.delete(key: 'host');
    await _storage.delete(key: 'port');
    await _storage.delete(key: 'username');
    await _storage.delete(key: 'password');
    await _storage.delete(key: 'autoLogin');

    savedCredentials = null;
    notifyListeners();
  }

  /* ---------------- SSH connection ---------------- */

  Future<void> connect({
    required String host,
    required int port,
    required String username,
    required String password,
    required bool remember,
    required bool autoLogin,
  }) async {
    if (isConnecting) return;

    isConnecting = true;
    errorMessage = null;
    notifyListeners();

    try {
      final socket = await SSHSocket.connect(host, port).timeout(
        const Duration(seconds: 12),
      );

      final client = SSHClient(
        socket,
        username: username,
        onPasswordRequest: () => password,
        keepAliveInterval: const Duration(seconds: 10),
      );

      await client.authenticated.timeout(
        const Duration(seconds: 12),
      );

      _client = client;
      isConnected = true;
      connectedHost = host;

      activeConnection = connections.firstWhere(
        (e) => e.host == host && e.username == username,
        orElse: () => ConnectionProfile(
          id: 'temp_${DateTime.now().millisecondsSinceEpoch}',
          name: '$username@$host',
          host: host,
          port: port,
          username: username,
          password: password,
          autoLogin: false,
        ),
      );

      savedCredentials = SavedCredentials(
        host: host,
        port: port,
        username: username,
        password: password,
        autoLogin: autoLogin,
      );

      if (remember) {
        await saveCredentials(
          host: host,
          port: port,
          username: username,
          password: password,
          autoLogin: autoLogin,
        );
      }

      _startPolling();
      await refreshAll();
    } catch (e) {
      errorMessage = 'SSH connection failed: $e';
      isConnected = false;
      connectedHost = null;
      activeConnection = null;
      _client?.close();
      _client = null;
    } finally {
      isConnecting = false;
      notifyListeners();
    }
  }

  Future<void> disconnect() async {
    await stopAgentSession(silent: true);

    _pollingTimer?.cancel();
    _pollingTimer = null;

    _client?.close();
    _client = null;

    isConnected = false;
    isPolling = false;
    connectedHost = null;
    activeConnection = null;
    lastUpdated = null;
    errorMessage = null;

    cpu = CpuMetric.empty();
    memory = MemoryMetric.empty();
    gpus = [];
    tasks = [];

    notifyListeners();
  }

  Future<void> reconnect() async {
    final saved = savedCredentials;
    if (saved == null) {
      errorMessage = 'No saved credentials for reconnect.';
      notifyListeners();
      return;
    }

    await disconnect();

    await connect(
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.password,
      remember: false,
      autoLogin: saved.autoLogin,
    );
  }

  void _startPolling() {
    _pollingTimer?.cancel();
    _pollingTimer = Timer.periodic(
      const Duration(seconds: 2),
      (_) => refreshAll(silent: true),
    );
  }

  /* ---------------- Metrics polling ---------------- */

  Future<void> refreshAll({bool silent = false}) async {
    if (!isConnected || isPolling) return;

    isPolling = true;
    if (!silent) notifyListeners();

    try {
      final results = await Future.wait([
        _fetchCpu(),
        _fetchMemory(),
        _fetchGpus(),
        _fetchTasks(),
      ]);

      cpu = results[0] as CpuMetric;
      memory = results[1] as MemoryMetric;
      gpus = results[2] as List<GpuMetric>;
      tasks = results[3] as List<TaskItem>;

      lastUpdated = DateTime.now();
      errorMessage = null;
      await _evaluateTaskQueue();
    } catch (e) {
      errorMessage = 'Refresh failed: $e';

      if (_client == null || _client!.isClosed) {
        isConnected = false;
      }
    } finally {
      isPolling = false;
      notifyListeners();
    }
  }

  Future<void> runCustomCommand(String command) async {
    if (command.trim().isEmpty || isRunningCommand) return;

    isRunningCommand = true;
    commandOutput = '';
    notifyListeners();

    try {
      final output = await _run(command, timeout: const Duration(seconds: 30));
      commandOutput = output.isEmpty ? '[No output]' : output;
      commandText = command;
    } catch (e) {
      commandOutput = 'Command failed: $e';
    } finally {
      isRunningCommand = false;
      notifyListeners();
    }
  }

  Future<String> _run(
    String command, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final client = _client;

    if (client == null || client.isClosed) {
      throw Exception('SSH client is not connected.');
    }

    final wrappedCommand = 'bash -lc ${_bashQuote(command)}';

    final result = await client.run(wrappedCommand).timeout(timeout);
    return utf8.decode(result, allowMalformed: true).trim();
  }

  String _bashQuote(String input) {
    return "'${input.replaceAll("'", "'\"'\"'")}'";
  }


  String _quoteShellArg(String input) {
    return "'${input.replaceAll("'", "'\"'\"'")}'";
  }

  void setSharedPwd(String path) {
    if (path.trim().isEmpty) return;
    sharedPwd = path.trim();
    notifyListeners();
  }

  Future<RemoteDirectoryListing> listRemoteDirectory(String path) async {
    final target = path.trim().isEmpty ? '~' : path.trim();
    final command = '''
target=${_quoteShellArg(target)}
case "\$target" in
  '~') target="\$HOME" ;;
  '~/'*) target="\$HOME/\${target#~/}" ;;
esac
if [ ! -d "\$target" ]; then
  echo "__ERROR__	Not a directory: \$target"
  exit 1
fi
cd "\$target" || exit 1
printf "__PWD__\t%s\n" "\$(pwd -P)"
find . -maxdepth 1 -mindepth 1 -printf '%y\t%f\t%s\t%TY-%Tm-%Td %TH:%TM\n' | sort -k1,1 -k2,2
''';

    final output = await _run(command, timeout: const Duration(seconds: 8));
    final lines = const LineSplitter().convert(output);

    String resolvedPath = target;
    final items = <RemoteFileItem>[];

    for (final line in lines) {
      if (line.trim().isEmpty) continue;

      final parts = line.split('\t');
      if (parts.isEmpty) continue;

      if (parts[0] == '__PWD__' && parts.length >= 2) {
        resolvedPath = parts[1];
        continue;
      }

      if (parts[0] == '__ERROR__') {
        throw Exception(parts.length >= 2 ? parts[1] : 'Directory error');
      }

      if (parts.length < 4) continue;

      final type = parts[0];
      final name = parts[1];
      if (name == '.' || name == '..') continue;

      final absPath = resolvedPath == '/' ? '/$name' : '$resolvedPath/$name';

      items.add(
        RemoteFileItem(
          name: name,
          path: absPath,
          type: type,
          sizeBytes: int.tryParse(parts[2]) ?? 0,
          modified: parts[3],
        ),
      );
    }

    items.sort((a, b) {
      if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });

    return RemoteDirectoryListing(path: resolvedPath, items: items);
  }

  Future<String> readRemoteFile(
    String path, {
    int maxBytes = 262144,
    int offset = 0,
  }) async {
    final target = _quoteShellArg(path);
    final command = '''
target=$target
if [ ! -f "\$target" ]; then
  echo "Not a regular file: \$target"
  exit 1
fi
size=\$(wc -c < "\$target" 2>/dev/null || echo 0)
tail -c +\$((offset + 1)) "\$target" | head -c $maxBytes
if [ "\$size" -gt \$((offset + maxBytes)) ]; then
  printf "\n\n[Preview truncated: showing bytes \$((offset + 1)) to \$((offset + maxBytes)) of %s bytes]" "\$size"
fi
''';
    return _run(command, timeout: const Duration(seconds: 8));
  }

  Future<Uint8List> readRemoteFileBytes(
    String path, {
    int maxBytes = 12 * 1024 * 1024,
  }) async {
    final target = _quoteShellArg(path);
    final command = '''
target=$target
if [ ! -f "\$target" ]; then
  echo "__ERROR__	Not a regular file: \$target"
  exit 1
fi
size=\$(wc -c < "\$target" 2>/dev/null || echo 0)
if [ "\$size" -gt $maxBytes ]; then
  echo "__TOO_LARGE__	\$size	$maxBytes"
  exit 2
fi
if base64 --help 2>&1 | grep -q -- '-w'; then
  base64 -w 0 "\$target"
else
  base64 "\$target" | tr -d '\n'
fi
''';

    final output = await _run(command, timeout: const Duration(seconds: 35));
    final trimmed = output.trim();

    if (trimmed.startsWith('__TOO_LARGE__')) {
      final parts = trimmed.split('	');
      final size = parts.length > 1 ? parts[1] : 'unknown';
      final limit = parts.length > 2 ? parts[2] : maxBytes.toString();
      throw Exception('File is too large for inline preview ($size bytes, limit $limit bytes).');
    }

    if (trimmed.startsWith('__ERROR__')) {
      final parts = trimmed.split('	');
      throw Exception(parts.length > 1 ? parts[1] : 'Unable to read file.');
    }

    if (trimmed.isEmpty) return Uint8List(0);
    return base64Decode(trimmed);
  }

  Future<void> writeRemoteFile(
    String path,
    String content, {
    int maxBytes = 1024 * 1024,
  }) async {
    final bytes = utf8.encode(content);
    if (bytes.length > maxBytes) {
      throw Exception('File is too large to save from inline editor (${bytes.length} bytes, limit $maxBytes bytes).');
    }

    final target = _quoteShellArg(path);
    final payload = _quoteShellArg(base64Encode(bytes));
    final command = '''
target=$target
payload=$payload
case "\$target" in
  '~') target="\$HOME" ;;
  '~/'*) target="\$HOME/\${target#~/}" ;;
esac
if [ -z "\$target" ] || [ -d "\$target" ]; then
  echo "__ERROR__	Target is not a regular file path: \$target"
  exit 1
fi
dir="\$(dirname -- "\$target")"
base="\$(basename -- "\$target")"
if [ ! -d "\$dir" ]; then
  echo "__ERROR__	Parent directory does not exist: \$dir"
  exit 1
fi
if [ -e "\$target" ] && [ ! -f "\$target" ]; then
  echo "__ERROR__	Target exists but is not a regular file: \$target"
  exit 1
fi
tmp="\$(mktemp "\$dir/.\$base.tmp.XXXXXX")" || {
  echo "__ERROR__	Unable to create temp file in \$dir"
  exit 1
}
if ! printf "%s" "\$payload" | base64 -d > "\$tmp" 2>/dev/null; then
  rm -f -- "\$tmp"
  echo "__ERROR__	Unable to decode edited content on remote host."
  exit 1
fi
if [ -e "\$target" ]; then
  chmod --reference="\$target" "\$tmp" 2>/dev/null || true
fi
if ! mv -- "\$tmp" "\$target"; then
  rm -f -- "\$tmp"
  echo "__ERROR__	Save failed. Check permissions and available disk space."
  exit 1
fi
''';

    final output = await _run(command, timeout: const Duration(seconds: 30));
    if (output.startsWith('__ERROR__')) {
      final parts = output.split('\t');
      throw Exception(parts.length > 1 ? parts[1] : 'Save failed.');
    }
  }

  Future<void> renameRemotePath(String path, String newName) async {
    if (newName.trim().isEmpty || newName.contains('/')) {
      throw Exception('New name cannot be empty or contain /.');
    }
    final source = _quoteShellArg(path);
    final name = _quoteShellArg(newName.trim());
    final command = '''
src=$source
dir=\$(dirname -- "\$src")
mv -- "\$src" "\$dir"/$name
''';
    await _run(command, timeout: const Duration(seconds: 8));
  }

  Future<String> duplicateRemotePath(String path) async {
    final source = _quoteShellArg(path);
    final command = '''
src=$source
dir=\$(dirname -- "\$src")
base=\$(basename -- "\$src")
dest="\$dir/\${base}_copy"
if [ -e "\$dest" ]; then
  dest="\$dir/\${base}_copy_\$(date +%Y%m%d_%H%M%S)"
fi
cp -a -- "\$src" "\$dest"
printf "%s" "\$dest"
''';
    return _run(command, timeout: const Duration(seconds: 30));
  }

  Future<String> copyRemotePathToDirectory(String sourcePath, String destinationDirectory) async {
    final source = _quoteShellArg(sourcePath);
    final destination = _quoteShellArg(destinationDirectory.trim().isEmpty ? '~' : destinationDirectory.trim());
    final command = '''
src=$source
dest_dir=$destination
case "\$dest_dir" in
  '~') dest_dir="\$HOME" ;;
  '~/'*) dest_dir="\$HOME/\${dest_dir#~/}" ;;
esac
if [ ! -e "\$src" ]; then
  echo "__ERROR__	Source does not exist: \$src"
  exit 1
fi
if [ ! -d "\$dest_dir" ]; then
  echo "__ERROR__	Destination is not a directory: \$dest_dir"
  exit 1
fi
dest_dir="\$(cd "\$dest_dir" && pwd -P)"
base="\$(basename -- "\$src")"
candidate="\$dest_dir/\$base"
if [ -e "\$candidate" ]; then
  stem="\$base"
  ext=""
  case "\$base" in
    *.*) stem="\${base%.*}"; ext=".\${base##*.}" ;;
  esac
  i=1
  while [ -e "\$dest_dir/\${stem}_copy\$i\$ext" ]; do
    i=\$((i + 1))
  done
  candidate="\$dest_dir/\${stem}_copy\$i\$ext"
fi
if ! cp -a -- "\$src" "\$candidate"; then
  echo "__ERROR__	Copy failed. Check permissions and available disk space."
  exit 1
fi
printf "%s" "\$candidate"
''';
    final output = await _run(command, timeout: const Duration(seconds: 120));
    if (output.startsWith('__ERROR__')) {
      final parts = output.split('	');
      throw Exception(parts.length > 1 ? parts[1] : 'Copy failed.');
    }
    return output;
  }

  Future<String> moveRemotePathToDirectory(String sourcePath, String destinationDirectory) async {
    final source = _quoteShellArg(sourcePath);
    final destination = _quoteShellArg(destinationDirectory.trim().isEmpty ? '~' : destinationDirectory.trim());
    final command = '''
src=$source
dest_dir=$destination
case "\$dest_dir" in
  '~') dest_dir="\$HOME" ;;
  '~/'*) dest_dir="\$HOME/\${dest_dir#~/}" ;;
esac
if [ ! -e "\$src" ]; then
  echo "__ERROR__	Source does not exist: \$src"
  exit 1
fi
if [ ! -d "\$dest_dir" ]; then
  echo "__ERROR__	Destination is not a directory: \$dest_dir"
  exit 1
fi
dest_dir="\$(cd "\$dest_dir" && pwd -P)"
base="\$(basename -- "\$src")"
candidate="\$dest_dir/\$base"
if [ "\$src" = "\$candidate" ]; then
  echo "__ERROR__	Source is already in this folder."
  exit 1
fi
if [ -e "\$candidate" ]; then
  echo "__ERROR__	Destination already exists: \$candidate"
  exit 1
fi
if ! mv -- "\$src" "\$candidate"; then
  echo "__ERROR__	Move failed. Check permissions."
  exit 1
fi
printf "%s" "\$candidate"
''';
    final output = await _run(command, timeout: const Duration(seconds: 45));
    if (output.startsWith('__ERROR__')) {
      final parts = output.split('	');
      throw Exception(parts.length > 1 ? parts[1] : 'Move failed.');
    }
    return output;
  }

  Future<void> deleteRemotePath(String path) async {
    final target = _quoteShellArg(path);
    final command = '''
target=$target
if [ -z "\$target" ] || [ "\$target" = "/" ]; then
  echo "__ERROR__	Refusing to delete root or empty path."
  exit 1
fi
if [ ! -e "\$target" ] && [ ! -L "\$target" ]; then
  echo "__ERROR__	Path does not exist: \$target"
  exit 1
fi
target_real="\$(readlink -f -- "\$target" 2>/dev/null || printf "%s" "\$target")"
home_real="\$(readlink -f -- "\$HOME" 2>/dev/null || printf "%s" "\$HOME")"
if [ "\$target_real" = "/" ] || [ "\$target_real" = "\$home_real" ]; then
  echo "__ERROR__	Refusing to delete root or home directory."
  exit 1
fi
if ! rm -rf -- "\$target"; then
  echo "__ERROR__	Delete failed. Check permissions."
  exit 1
fi
''';
    final output = await _run(command, timeout: const Duration(seconds: 45));
    if (output.startsWith('__ERROR__')) {
      final parts = output.split('	');
      throw Exception(parts.length > 1 ? parts[1] : 'Delete failed.');
    }
  }

  Future<String> resolveRemotePath(String path) async {
    final target = _quoteShellArg(path.trim().isEmpty ? '~' : path.trim());
    final command = '''
target=$target
case "\$target" in
  '~') target="\$HOME" ;;
  '~/'*) target="\$HOME/\${target#~/}" ;;
esac
cd "\$target" 2>/dev/null && pwd -P
''';
    return _run(command, timeout: const Duration(seconds: 4));
  }

  Future<CpuMetric> _fetchCpu() async {
    const marker = '__DASHBOARD_CPU_SPLIT__';

    final output = await _run(
      'cat /proc/stat; echo $marker; sleep 0.35; cat /proc/stat',
      timeout: const Duration(seconds: 4),
    );

    final parts = output.split(marker);
    if (parts.length < 2) return CpuMetric.empty();

    final before = _parseProcStat(parts[0]);
    final after = _parseProcStat(parts[1]);

    final totalBefore = before[-1];
    final totalAfter = after[-1];

    final totalUsage = totalBefore == null || totalAfter == null
        ? 0.0
        : _calculateCpuUsage(totalBefore, totalAfter);

    final indexes = after.keys.where((key) => key >= 0).toList()..sort();

    final cores = <CpuCoreMetric>[];

    for (final index in indexes) {
      final b = before[index];
      final a = after[index];

      if (b == null || a == null) continue;

      cores.add(
        CpuCoreMetric(
          index: index,
          usage: _calculateCpuUsage(b, a),
        ),
      );
    }

    return CpuMetric(
      totalUsage: totalUsage,
      cores: cores,
    );
  }

  Map<int, _CpuStat> _parseProcStat(String text) {
    final result = <int, _CpuStat>{};

    for (final line in const LineSplitter().convert(text)) {
      final trimmed = line.trim();
      if (!trimmed.startsWith('cpu')) continue;

      final parts = trimmed.split(RegExp(r'\s+'));
      if (parts.length < 8) continue;

      final label = parts[0];

      int? index;
      if (label == 'cpu') {
        index = -1;
      } else if (RegExp(r'^cpu\d+$').hasMatch(label)) {
        index = int.tryParse(label.substring(3));
      }

      if (index == null) continue;

      int readInt(int i) {
        if (i >= parts.length) return 0;
        return int.tryParse(parts[i]) ?? 0;
      }

      result[index] = _CpuStat(
        user: readInt(1),
        nice: readInt(2),
        system: readInt(3),
        idle: readInt(4),
        iowait: readInt(5),
        irq: readInt(6),
        softirq: readInt(7),
        steal: readInt(8),
      );
    }

    return result;
  }

  double _calculateCpuUsage(_CpuStat before, _CpuStat after) {
    final totalDiff = after.total - before.total;
    final idleDiff = after.idleAll - before.idleAll;

    if (totalDiff <= 0) return 0;

    final usage = (totalDiff - idleDiff) / totalDiff * 100;
    return usage.clamp(0.0, 100.0).toDouble();
  }

  Future<MemoryMetric> _fetchMemory() async {
    final output = await _run(
      "free -m | awk '/^Mem:/ {print \$3 \",\" \$2}'",
      timeout: const Duration(seconds: 3),
    );

    final parts = output.split(',');
    if (parts.length < 2) return MemoryMetric.empty();

    return MemoryMetric(
      usedMb: _toDouble(parts[0]),
      totalMb: _toDouble(parts[1]),
    );
  }

  Future<List<GpuMetric>> _fetchGpus() async {
    const appMarker = '__DASHBOARD_GPU_APP_SPLIT__';
    const psMarker = '__DASHBOARD_PS_SPLIT__';

    final output = await _run(
      r'''
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true
  printf '\n__DASHBOARD_GPU_APP_SPLIT__\n'
  nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true
  printf '\n__DASHBOARD_PS_SPLIT__\n'
  ps -eo pid=,user=,etimes=,args= 2>/dev/null | awk '
    {
      pid=$1;
      user=$2;
      etimes=$3;
      sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]*/, "", $0);
      gsub(/\t/, " ", $0);
      gsub(/[[:space:]][[:space:]]+/, " ", $0);
      if (pid != "") printf "__PS__\t%s\t%s\t%s\t%s\n", pid, user, etimes, $0;
    }
  ' || true
else
  true
fi
''',
      timeout: const Duration(seconds: 15),
    );

    if (output.trim().isEmpty) return [];

    final appSplit = output.split(appMarker);
    final gpuText = appSplit.isNotEmpty ? appSplit[0] : '';
    final afterAppMarker = appSplit.length > 1 ? appSplit.sublist(1).join(appMarker) : '';
    final psSplit = afterAppMarker.split(psMarker);
    final processText = psSplit.isNotEmpty ? psSplit[0] : '';
    final psText = psSplit.length > 1 ? psSplit.sublist(1).join(psMarker) : '';

    final processMetaByPid = <int, _GpuProcessMetadata>{};
    for (final line in const LineSplitter().convert(psText)) {
      final trimmed = line.trim();
      if (trimmed.isEmpty || !trimmed.startsWith('__PS__	')) continue;

      final parts = trimmed.split('	');
      if (parts.length < 5) continue;

      final pid = int.tryParse(parts[1].trim());
      if (pid == null) continue;

      final commandLine = parts.sublist(4).join('	').trim();
      processMetaByPid[pid] = _GpuProcessMetadata(
        username: parts[2].trim().isEmpty ? 'unknown' : parts[2].trim(),
        runtimeSeconds: int.tryParse(parts[3].trim()),
        commandLine: commandLine,
      );
    }

    final processesByUuid = <String, List<GpuProcessMetric>>{};

    for (final line in const LineSplitter().convert(processText)) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      if (trimmed.toLowerCase().contains('no running processes')) continue;

      final parts = trimmed.split(',').map((e) => e.trim()).toList();
      if (parts.length < 4) continue;

      final uuid = parts[0];
      final pid = int.tryParse(parts[1]) ?? 0;
      final processName = parts[2];
      final processMeta = processMetaByPid[pid];
      final commandLine = processMeta != null && processMeta.commandLine.trim().isNotEmpty
          ? processMeta.commandLine
          : processName;

      final process = GpuProcessMetric(
        pid: pid,
        username: processMeta?.username ?? 'unknown',
        processName: processName,
        commandLine: commandLine,
        usedMemoryMb: _toDouble(parts[3]),
        runtimeSeconds: processMeta?.runtimeSeconds,
      );

      processesByUuid.putIfAbsent(uuid, () => <GpuProcessMetric>[]).add(process);
    }

    final items = <GpuMetric>[];

    for (final line in const LineSplitter().convert(gpuText)) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;

      final parts = trimmed.split(',').map((e) => e.trim()).toList();

      if (parts.length < 7) continue;

      final uuid = parts[1];
      items.add(
        GpuMetric(
          index: int.tryParse(parts[0]) ?? items.length,
          uuid: uuid,
          name: parts[2],
          usage: _toDouble(parts[3]),
          memoryUsedMb: _toDouble(parts[4]),
          memoryTotalMb: _toDouble(parts[5]),
          temperature: _toDouble(parts[6]),
          processes: List.unmodifiable(processesByUuid[uuid] ?? const <GpuProcessMetric>[]),
        ),
      );
    }

    return items;
  }

  Future<List<TaskItem>> _fetchTasks() async {
    final output = await _run(
      '''
if [ -f ~/.dashboard_tasks.json ]; then
  cat ~/.dashboard_tasks.json
else
  echo "[]"
fi
''',
      timeout: const Duration(seconds: 3),
    );

    if (output.trim().isEmpty) return [];

    try {
      final decoded = jsonDecode(output);

      if (decoded is List) {
        return [
          for (int i = 0; i < decoded.length; i++)
            TaskItem.fromJson(decoded[i], i),
        ];
      }

      if (decoded is Map && decoded['tasks'] is List) {
        final list = decoded['tasks'] as List;
        return [
          for (int i = 0; i < list.length; i++) TaskItem.fromJson(list[i], i),
        ];
      }

      return [
        TaskItem(
          title: 'Invalid task format',
          status: 'Error',
          detail: 'Expected JSON array or {"tasks": [...]}',
        ),
      ];
    } catch (e) {
      return [
        TaskItem(
          title: 'Task JSON parse failed',
          status: 'Error',
          detail: e.toString(),
        ),
      ];
    }
  }

  Future<void> addTask(TaskItem task) async {
    final next = [task, ...tasks];
    await _persistTasks(next);
    tasks = next;
    notifyListeners();
  }

  Future<void> deleteTask(TaskItem task) async {
    final next = tasks.where((item) => item.id != task.id).toList();
    await _persistTasks(next);
    tasks = next;
    notifyListeners();
  }

  Future<void> cancelTask(TaskItem task) async {
    TaskItem nextTask = task.copyWith(
      status: 'cancelled',
      detail: 'Cancelled by user.',
    );

    final pid = task.pid;
    if (pid != null && pid > 0 && task.isRunning) {
      try {
        await _run('kill $pid 2>/dev/null || true', timeout: const Duration(seconds: 3));
        nextTask = nextTask.copyWith(detail: 'Cancelled by user. Sent SIGTERM to PID $pid.');
      } catch (_) {}
    }

    await _replaceTask(nextTask);
  }

  Future<void> launchTask(TaskItem task) async {
    if (!task.hasLaunchCommand) {
      throw Exception('Task has no launch command.');
    }
    final gpu = _selectGpuForTask(task);
    await _launchTaskOnRemote(task, gpu);
  }

  Future<void> _replaceTask(TaskItem nextTask) async {
    final next = [
      for (final item in tasks) item.id == nextTask.id ? nextTask : item,
    ];
    await _persistTasks(next);
    tasks = next;
    notifyListeners();
  }

  Future<void> _persistTasks(List<TaskItem> nextTasks) async {
    final payload = const JsonEncoder.withIndent('  ').convert({
      'tasks': nextTasks.map((item) => item.toJson()).toList(),
    });
    await writeRemoteFile('~/.dashboard_tasks.json', payload, maxBytes: 1024 * 1024);
  }

  Future<void> _evaluateTaskQueue() async {
    if (isTaskQueueBusy || tasks.isEmpty) return;

    isTaskQueueBusy = true;
    try {
      var next = List<TaskItem>.from(tasks);
      var changed = false;

      for (var i = 0; i < next.length; i++) {
        final task = next[i];
        final pid = task.pid;
        if (!task.isRunning || pid == null || pid <= 0) continue;

        final alive = await _isPidAlive(pid);
        if (!alive) {
          next[i] = task.copyWith(
            status: 'completed',
            detail: 'Process ended. Check log: ${task.logPath ?? 'unknown log path'}',
          );
          changed = true;
        }
      }

      if (changed) {
        await _persistTasks(next);
        tasks = next;
      }

      for (final task in List<TaskItem>.from(tasks)) {
        final status = task.status.toLowerCase();
        final mode = (task.launchMode ?? '').toLowerCase();

        if (task.isTerminalState || task.isRunning || !task.hasLaunchCommand) continue;

        if (mode == 'scheduled' && status.contains('scheduled')) {
          final scheduled = _parseLocalDateTime(task.scheduledAt);
          if (scheduled != null && !scheduled.isAfter(DateTime.now())) {
            await _launchTaskOnRemote(task, _selectGpuForTask(task));
          }
        }

        if (mode == 'wait_for_idle' && (status.contains('wait') || status.contains('queued'))) {
          final gpu = _selectGpuForTask(task, requireIdle: true);
          if (gpu != null) {
            await _launchTaskOnRemote(task, gpu);
          }
        }
      }
    } catch (e) {
      errorMessage = 'Task queue update failed: $e';
    } finally {
      isTaskQueueBusy = false;
    }
  }

  Future<bool> _isPidAlive(int pid) async {
    try {
      final output = await _run('ps -p $pid -o pid=', timeout: const Duration(seconds: 3));
      return output.trim().isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  DateTime? _parseLocalDateTime(String? value) {
    final raw = value?.trim();
    if (raw == null || raw.isEmpty) return null;
    final normalized = raw.contains('T') ? raw : raw.replaceFirst(' ', 'T');
    return DateTime.tryParse(normalized);
  }

  GpuMetric? _selectGpuForTask(TaskItem task, {bool requireIdle = false}) {
    if (gpus.isEmpty) return null;

    Iterable<GpuMetric> candidates = gpus;
    final target = task.targetGpuIndex;
    if (target != null) {
      candidates = candidates.where((gpu) => gpu.index == target);
    }

    final sorted = candidates.toList()
      ..sort((a, b) => a.memoryUsedMb.compareTo(b.memoryUsedMb));

    for (final gpu in sorted) {
      if (!requireIdle || _isGpuIdleForTask(gpu, task)) {
        return gpu;
      }
    }
    return null;
  }

  bool _isGpuIdleForTask(GpuMetric gpu, TaskItem task) {
    final maxMemory = task.maxGpuMemoryMb ?? 1500;
    final maxUtil = task.maxGpuUtilization ?? 10;
    final now = DateTime.now();
    final isIdleNow = gpu.memoryUsedMb <= maxMemory && gpu.usage <= maxUtil;

    if (!isIdleNow) {
      _gpuIdleSince.remove(gpu.index);
      return false;
    }

    _gpuIdleSince.putIfAbsent(gpu.index, () => now);
    final requiredSeconds = task.requiredIdleSeconds ?? 0;
    if (requiredSeconds <= 0) return true;

    final idleSince = _gpuIdleSince[gpu.index] ?? now;
    return now.difference(idleSince).inSeconds >= requiredSeconds;
  }

  Future<void> _launchTaskOnRemote(TaskItem task, GpuMetric? gpu) async {
    final command = task.command?.trim();
    if (command == null || command.isEmpty) return;

    if (task.targetGpuIndex != null && gpu == null) {
      final message = 'Target GPU ${task.targetGpuIndex} is not available.';
      await _replaceTask(task.copyWith(status: 'failed', detail: message));
      throw Exception(message);
    }

    final runId = task.id.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_');
    final gpuIndex = gpu == null ? '' : gpu.index.toString();
    var script = r'''
mkdir -p "$HOME/.ssh_dashboard/runs"
run_id=__RUN_ID__
log="$HOME/.ssh_dashboard/runs/${run_id}.log"
target=__CWD__
cmd=__COMMAND__
gpu_index=__GPU_INDEX__
case "$target" in
  '~') target="$HOME" ;;
  '~/'*) target="$HOME/${target#~/}" ;;
esac
if [ ! -d "$target" ]; then
  echo "__ERROR__	Working directory does not exist: $target"
  exit 1
fi
cd "$target" || exit 1
if [ -n "$gpu_index" ]; then
  launch="CUDA_VISIBLE_DEVICES=${gpu_index} exec bash -lc $cmd"
else
  launch="exec bash -lc $cmd"
fi
nohup bash -lc "$launch" > "$log" 2>&1 &
pid=$!
printf "__STARTED__	%s	%s
" "$pid" "$log"
''';
    script = script
        .replaceAll('__RUN_ID__', _quoteShellArg(runId))
        .replaceAll('__CWD__', _quoteShellArg((task.cwd == null || task.cwd!.trim().isEmpty) ? '~' : task.cwd!.trim()))
        .replaceAll('__COMMAND__', _quoteShellArg(command))
        .replaceAll('__GPU_INDEX__', _quoteShellArg(gpuIndex));

    final output = await _run(script, timeout: const Duration(seconds: 8));

    if (output.startsWith('__ERROR__')) {
      final parts = output.split('\t');
      final message = parts.length > 1 ? parts[1] : 'Task launch failed.';
      await _replaceTask(task.copyWith(status: 'failed', detail: message));
      throw Exception(message);
    }

    final parts = output.split('\t');
    final pid = parts.length > 1 ? int.tryParse(parts[1]) : null;
    final logPath = parts.length > 2 ? parts[2].trim() : null;
    final gpuText = gpu == null ? 'default GPU visibility' : 'GPU ${gpu.index}';

    await _replaceTask(
      task.copyWith(
        status: 'running',
        detail: 'Started on $gpuText. PID: ${pid ?? 'unknown'}. Log: ${logPath ?? 'unknown'}',
        pid: pid,
        logPath: logPath,
        lastStartedAt: DateTime.now().toIso8601String(),
      ),
    );
  }

  double _toDouble(String value) {
    final cleaned = value
        .replaceAll('%', '')
        .replaceAll('MiB', '')
        .replaceAll('MB', '')
        .replaceAll('C', '')
        .replaceAll('[N/A]', '0')
        .trim();

    return double.tryParse(cleaned) ?? 0;
  }

  /* ---------------- Hidden PTY agent ---------------- */

  Future<void> startAgentSession({
    required String name,
    required String command,
  }) async {
    if (isAgentSessionStarting) return;

    final client = _client;
    if (client == null || client.isClosed) {
      agentMessages.add(
        AgentMessage(
          role: 'system',
          text: 'SSH 尚未連線，無法啟動 agent。',
          time: DateTime.now(),
        ),
      );
      notifyListeners();
      return;
    }

    await stopAgentSession(silent: true);

    isAgentSessionStarting = true;
    isAgentSessionReady = false;
    isAgentStreaming = false;
    activeAgentName = name;
    activeAgentCommand = command;
    agentDraft = '';
    agentScreenText = '';
    agentSuggestions = [];
    _lastAssistantScreenText = '';

    agentMessages.add(
      AgentMessage(
        role: 'system',
        text: 'Starting $name session...',
        time: DateTime.now(),
      ),
    );
    notifyListeners();

    try {
      final terminal = Terminal(
        maxLines: 2000,
        platform: currentTerminalTargetPlatform(),
        onOutput: (data) {
          final session = _agentSession;
          if (session == null) return;
          session.write(Uint8List.fromList(utf8.encode(data)));
        },
      );

      terminal.resize(100, 30);
      _hiddenAgentTerminal = terminal;

      final session = await client.shell(
        pty: const SSHPtyConfig(
          type: 'xterm-256color',
          width: 100,
          height: 30,
        ),
      );

      _agentSession = session;

      _agentStdoutSub = session.stdout.listen(
        (data) {
          final text = utf8.decode(data, allowMalformed: true);
          _hiddenAgentTerminal?.write(text);
          _refreshAgentUiFromHiddenTerminal();
        },
        onError: (error) {
          _addSystemAgentMessage('agent stdout error: $error');
        },
      );

      _agentStderrSub = session.stderr.listen(
        (data) {
          final text = utf8.decode(data, allowMalformed: true);
          _hiddenAgentTerminal?.write(text);
          _refreshAgentUiFromHiddenTerminal();
        },
        onError: (error) {
          _addSystemAgentMessage('agent stderr error: $error');
        },
      );

      session.done.then((_) {
        isAgentSessionReady = false;
        isAgentStreaming = false;
        _agentSession = null;

        agentMessages.add(
          AgentMessage(
            role: 'system',
            text: '$activeAgentName session closed.',
            time: DateTime.now(),
          ),
        );

        notifyListeners();
      });

      await Future.delayed(const Duration(milliseconds: 300));
      session.write(Uint8List.fromList(utf8.encode('$command\r')));

      isAgentSessionStarting = false;
      isAgentSessionReady = true;

      agentMessages.add(
        AgentMessage(
          role: 'system',
          text: '$name session started. Type / to open command suggestions.',
          time: DateTime.now(),
        ),
      );

      notifyListeners();
    } catch (e) {
      isAgentSessionStarting = false;
      isAgentSessionReady = false;

      agentMessages.add(
        AgentMessage(
          role: 'system',
          text: 'Agent session 啟動失敗：$e',
          time: DateTime.now(),
        ),
      );

      notifyListeners();
    }
  }

  Future<void> stopAgentSession({bool silent = false}) async {
    _agentIdleTimer?.cancel();
    _agentIdleTimer = null;

    await _agentStdoutSub?.cancel();
    await _agentStderrSub?.cancel();

    _agentStdoutSub = null;
    _agentStderrSub = null;

    try {
      _agentSession?.write(Uint8List.fromList([3])); // Ctrl+C
      await Future.delayed(const Duration(milliseconds: 100));
      _agentSession?.close();
    } catch (_) {}

    _agentSession = null;
    _hiddenAgentTerminal = null;

    isAgentSessionReady = false;
    isAgentSessionStarting = false;
    isAgentStreaming = false;

    agentDraft = '';
    agentSuggestions = [];
    agentScreenText = '';
    _lastAssistantScreenText = '';

    if (!silent) {
      agentMessages.add(
        AgentMessage(
          role: 'system',
          text: 'Agent session stopped.',
          time: DateTime.now(),
        ),
      );
    }

    notifyListeners();
  }

  void clearAgentMessages() {
    agentMessages = [];
    _lastAssistantScreenText = '';
    notifyListeners();
  }

  void syncAgentDraftToPty(String nextDraft) {
    final session = _agentSession;

    if (session == null || !isAgentSessionReady) {
      agentDraft = nextDraft;
      agentSuggestions = _extractAgentSuggestions(agentScreenText);
      notifyListeners();
      return;
    }

    final patch = _buildTerminalInputPatch(agentDraft, nextDraft);

    if (patch.isNotEmpty) {
      session.write(Uint8List.fromList(utf8.encode(patch)));
    }

    agentDraft = nextDraft;
    agentSuggestions = _extractAgentSuggestions(agentScreenText);
    notifyListeners();
  }

  String _buildTerminalInputPatch(String oldText, String newText) {
    if (oldText == newText) return '';

    // Most mobile edits are append/backspace at the end; optimize for that.
    if (newText.startsWith(oldText)) {
      return newText.substring(oldText.length);
    }

    if (oldText.startsWith(newText)) {
      final deleteCount = oldText.length - newText.length;
      return List.filled(deleteCount, '\x7f').join();
    }

    // Fallback: clear current line, then type the new draft.
    // Ctrl+U is broadly supported by readline-style CLIs.
    return '\x15$newText';
  }

  void applyAgentSuggestion(AgentSuggestion suggestion) {
    syncAgentDraftToPty(suggestion.insertText);
    agentSuggestions = [];
    notifyListeners();
  }

  Future<void> submitAgentDraft() async {
    final session = _agentSession;

    if (session == null || !isAgentSessionReady) {
      _addSystemAgentMessage('Agent session 尚未啟動。');
      return;
    }

    final text = agentDraft.trim();
    if (text.isEmpty) return;

    agentMessages.add(
      AgentMessage(
        role: 'user',
        text: text,
        time: DateTime.now(),
      ),
    );

    agentDraft = '';
    agentSuggestions = [];
    isAgentStreaming = true;

    session.write(Uint8List.fromList(utf8.encode('\r')));

    notifyListeners();
  }

  void sendAgentControl(String data) {
    final session = _agentSession;
    if (session == null || !isAgentSessionReady) return;
    session.write(Uint8List.fromList(utf8.encode(data)));
  }

  void _refreshAgentUiFromHiddenTerminal() {
    final terminal = _hiddenAgentTerminal;
    if (terminal == null) return;

    final screen = _readHiddenTerminalScreen(terminal);

    agentScreenText = screen;
    agentSuggestions = _extractAgentSuggestions(screen);

    final assistantText = _extractAssistantText(screen);

    if (assistantText.trim().isNotEmpty &&
        assistantText.trim() != _lastAssistantScreenText.trim()) {
      _lastAssistantScreenText = assistantText;
      _upsertStreamingAssistantMessage(assistantText);
    }

    isAgentStreaming = true;

    _agentIdleTimer?.cancel();
    _agentIdleTimer = Timer(const Duration(milliseconds: 900), () {
      isAgentStreaming = false;
      notifyListeners();
    });

    notifyListeners();
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

  List<AgentSuggestion> _extractAgentSuggestions(String screen) {
    final draft = agentDraft.trim();
    if (!draft.startsWith('/')) return [];

    final merged = <String, AgentSuggestion>{};

    for (final item in _localSlashSuggestions(draft)) {
      merged[item.insertText] = item;
    }

    // Only include dynamic suggestions that match the current draft.
    for (final item in _dynamicSlashSuggestionsFromScreen(screen)) {
      final lowerLabel = item.label.toLowerCase();
      final lowerDraft = draft.toLowerCase();
      final withoutSlash = lowerDraft.replaceFirst('/', '');
      if (lowerLabel.startsWith(lowerDraft) || lowerLabel.contains(withoutSlash)) {
        merged[item.insertText] = item;
      }
    }

    return merged.values.toList();
  }

  List<AgentSuggestion> _localSlashSuggestions(String query) {
    final all = <AgentSuggestion>[
      const AgentSuggestion(
        label: '/help',
        description: 'Show available commands',
        insertText: '/help',
      ),
      const AgentSuggestion(
        label: '/clear',
        description: 'Clear current conversation if supported',
        insertText: '/clear',
      ),
      const AgentSuggestion(
        label: '/compact',
        description: 'Compact or summarize context if supported',
        insertText: '/compact',
      ),
      const AgentSuggestion(
        label: '/model',
        description: 'Change model if supported by the CLI',
        insertText: '/model',
      ),
      const AgentSuggestion(
        label: '/status',
        description: 'Show current agent status if supported',
        insertText: '/status',
      ),
      const AgentSuggestion(
        label: '/quit',
        description: 'Exit current agent session if supported',
        insertText: '/quit',
      ),
    ];

    return all.where((item) => item.label.startsWith(query)).toList();
  }

  List<AgentSuggestion> _dynamicSlashSuggestionsFromScreen(String screen) {
    final result = <AgentSuggestion>[];
    final lines = const LineSplitter().convert(screen);

    for (final raw in lines) {
      final line = raw.trim();
      // Try to match a slash command with an optional description.  The
      // description may be separated from the command by a dash/colon or
      // by one or more spaces.  This captures lines like:
      // "/help - Show help", "/help  Show help", "/help Show help".
      final slashWithDesc = RegExp(
        // Allow commands to be preceded by bullets (no arrow prefix here).
        r'^(?:[>›•\-*]\s*)?(\/[-a-zA-Z0-9_]+)\s*(?:[-:–—]\s*|\s+)(.*)$',
      ).firstMatch(line);
      if (slashWithDesc != null) {
        final cmd = slashWithDesc.group(1) ?? '';
        final desc = slashWithDesc.group(2) ?? '';
        if (cmd.isNotEmpty) {
          result.add(AgentSuggestion(label: cmd, description: desc, insertText: cmd));
        }
        continue;
      }
      // Fallback: match a slash command with no description.  This
      // captures lines that consist solely of a slash command (with
      // optional bullet prefix).
      final singleCmd = RegExp(
        // Same bullet prefix as above for commands without descriptions (no arrows).
        r'^(?:[>›•\-*]\s*)?(\/[-a-zA-Z0-9_]+)\s*$',
      ).firstMatch(line);
      if (singleCmd != null) {
        final cmd = singleCmd.group(1) ?? '';
        if (cmd.isNotEmpty) {
          result.add(AgentSuggestion(label: cmd, description: '', insertText: cmd));
        }
        continue;
      }
    }

    return result;
  }

  String _extractAssistantText(String screen) {
    final lines = const LineSplitter().convert(screen);
    final visible = <String>[];

    for (final raw in lines) {
      final line = raw.trimRight();
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;

      if (_isNoiseAgentLine(trimmed)) continue;
      visible.add(line);
    }

    final joined = visible.join('\n').trim();

    // Keep the assistant bubble readable by limiting to recent screen content.
    final split = const LineSplitter().convert(joined);
    final recent = split.length > 40 ? split.sublist(split.length - 40) : split;
    return recent.join('\n').trim();
  }

  bool _isNoiseAgentLine(String line) {
    // Lines that contain slash commands should be treated as noise to avoid
    // showing them as assistant content.  Slash commands may be preceded by
    // simple bullet characters such as >, ›, •, -, *.  Allow for an optional
    // prefix and match a slash followed by a command.
    if (RegExp(r'^(?:[>›•\-*]\s*)?\/[a-zA-Z0-9_\-]+').hasMatch(line)) {
      return true;
    }

    final lower = line.toLowerCase();
    if (lower.contains('press esc')) return true;
    if (lower.contains('type /')) return true;
    if (lower.contains('ctrl+c')) return true;
    if (lower.contains('ctrl-d')) return true;
    if (lower.contains('loading')) return true;
    if (lower.contains('thinking')) return true;
    if (lower == 'codex' || lower == 'gemini') return true;
    if (line.startsWith(r'$ ')) return true;

    return false;
  }

  void _upsertStreamingAssistantMessage(String text) {
    if (agentMessages.isNotEmpty && agentMessages.last.role == 'assistant') {
      final last = agentMessages.removeLast();
      agentMessages.add(
        AgentMessage(
          role: 'assistant',
          text: text,
          time: last.time,
        ),
      );
    } else {
      agentMessages.add(
        AgentMessage(
          role: 'assistant',
          text: text,
          time: DateTime.now(),
        ),
      );
    }
  }

  void _addSystemAgentMessage(String text) {
    agentMessages.add(
      AgentMessage(
        role: 'system',
        text: text,
        time: DateTime.now(),
      ),
    );
    notifyListeners();
  }

  /* ---------------- Hermes remote runtime / tmux mode ---------------- */

  Future<String> runRemoteShell(
    String command, {
    Duration timeout = const Duration(seconds: 30),
  }) {
    return _run(command, timeout: timeout);
  }

  Future<HermesRemoteRuntimeInfo> bootstrapHermesRemoteRuntime({
    bool installTmuxIfPossible = false,
  }) async {
    final installFlag = installTmuxIfPossible ? '1' : '0';
    final output = await _run(
      '''
set -u
root="\$HOME/.ssh_dashboard"
bin="\$root/bin"
mkdir -p "\$bin" "\$root/logs" "\$root/sessions" "\$root/tmux_meta" "\$root/skills" "\$root/tools" "\$root/memory"
cat > "\$bin/sdh-probe" <<'SH'
#!/usr/bin/env bash
set -u
case "\${1:-status}" in
  status)
    printf "host=%s\\n" "\$(hostname 2>/dev/null || echo unknown)"
    printf "pwd=%s\\n" "\$(pwd -P 2>/dev/null || pwd)"
    printf "tmux=%s\\n" "\$(command -v tmux 2>/dev/null || true)"
    printf "python=%s\\n" "\$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
    printf "git=%s\\n" "\$(command -v git 2>/dev/null || true)"
    ;;
  *)
    echo "sdh-probe: unknown command: \$1" >&2
    exit 2
    ;;
esac
SH
chmod +x "\$bin/sdh-probe"

if ! command -v tmux >/dev/null 2>&1 && [ "$installFlag" = "1" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update -y >/dev/null 2>&1 || true
      sudo apt-get install -y tmux >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y tmux >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      sudo yum install -y tmux >/dev/null 2>&1 || true
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -Sy --noconfirm tmux >/dev/null 2>&1 || true
    fi
  fi
fi

tmux_path="\$(command -v tmux 2>/dev/null || true)"
python_path="\$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
git_path="\$(command -v git 2>/dev/null || true)"
tmux_version=""
if [ -n "\$tmux_path" ]; then
  tmux_version="\$(tmux -V 2>/dev/null || true)"
fi
ok="true"
message="remote runtime ready"
if [ -z "\$tmux_path" ]; then
  ok="false"
  message="remote runtime installed but tmux is unavailable; enable install_tmux or install tmux on the server"
fi
printf "__SDH_RUNTIME__\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "\$ok" "\$root" "\$bin" "\${tmux_path:+true}" "\${python_path:+true}" "\${git_path:+true}" "\$tmux_version" "\$message"
''',
      timeout: const Duration(seconds: 45),
    );
    for (final line in const LineSplitter().convert(output)) {
      if (!line.startsWith('__SDH_RUNTIME__\t')) continue;
      final parts = line.split('\t');
      return HermesRemoteRuntimeInfo(
        ok: parts.length > 1 && parts[1] == 'true',
        home: parts.length > 2 ? parts[2] : '~/.ssh_dashboard',
        binDir: parts.length > 3 ? parts[3] : '~/.ssh_dashboard/bin',
        tmuxAvailable: parts.length > 4 && parts[4] == 'true',
        pythonAvailable: parts.length > 5 && parts[5] == 'true',
        gitAvailable: parts.length > 6 && parts[6] == 'true',
        tmuxVersion: parts.length > 7 ? parts[7] : '',
        message: parts.length > 8 ? parts.sublist(8).join('\t') : 'remote runtime ready',
      );
    }
    return HermesRemoteRuntimeInfo(
      ok: false,
      home: '~/.ssh_dashboard',
      binDir: '~/.ssh_dashboard/bin',
      tmuxAvailable: false,
      pythonAvailable: false,
      gitAvailable: false,
      tmuxVersion: '',
      message: output.trim().isEmpty ? 'Remote bootstrap returned no status.' : output.trim(),
    );
  }

  Future<List<HermesTmuxSessionInfo>> listHermesTmuxSessions() async {
    final output = await _run(
      r'''
if ! command -v tmux >/dev/null 2>&1; then
  echo "__ERROR__	tmux is not installed"
  exit 0
fi
mkdir -p "$HOME/.ssh_dashboard/tmux_meta"
tmux ls -F '#{session_name}	#{session_created}	#{session_windows}	#{session_attached}' 2>/dev/null | while IFS=$'\t' read -r name created windows attached; do
  case "$name" in
    sdh_*) ;;
    *) continue ;;
  esac
  meta="$HOME/.ssh_dashboard/tmux_meta/$name.tsv"
  cwd=""
  cmd=""
  if [ -f "$meta" ]; then
    IFS=$'\t' read -r cwd cmd < "$meta" || true
  fi
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$created" "$windows" "$attached" "$cwd" "$cmd"
done
''',
      timeout: const Duration(seconds: 8),
    );
    return [
      for (final line in const LineSplitter().convert(output))
        if (line.trim().isNotEmpty && !line.startsWith('__ERROR__')) HermesTmuxSessionInfo.fromTsv(line),
    ];
  }

  Future<HermesTmuxSessionInfo> startHermesTmuxSession({
    required String name,
    required String command,
    String cwd = '~',
    bool attachIfExists = true,
  }) async {
    final sessionName = HermesRemoteCommandPolicy.normalizeSessionName(name);
    final output = await _run(
      '''
if ! command -v tmux >/dev/null 2>&1; then
  echo "__ERROR__\ttmux is not installed. Run remote.bootstrap with install_tmux=true or install tmux manually."
  exit 0
fi
session=${_quoteShellArg(sessionName)}
cwd=${_quoteShellArg(cwd.trim().isEmpty ? '~' : cwd.trim())}
cmd=${_quoteShellArg(command.trim().isEmpty ? 'exec bash' : command.trim())}
attach_existing=${attachIfExists ? '1' : '0'}
case "\$cwd" in
  '~') cwd="\$HOME" ;;
  '~/'*) cwd="\$HOME/\${cwd#~/}" ;;
esac
if [ ! -d "\$cwd" ]; then
  echo "__ERROR__\tWorking directory does not exist: \$cwd"
  exit 0
fi
mkdir -p "\$HOME/.ssh_dashboard/tmux_meta" "\$HOME/.ssh_dashboard/logs"
if tmux has-session -t "\$session" 2>/dev/null; then
  if [ "\$attach_existing" = "1" ]; then
    created="\$(tmux display-message -p -t "\$session" '#{session_created}' 2>/dev/null || echo '')"
    windows="\$(tmux display-message -p -t "\$session" '#{session_windows}' 2>/dev/null || echo '')"
    attached="\$(tmux display-message -p -t "\$session" '#{session_attached}' 2>/dev/null || echo '')"
    printf "__TMUX__\t%s\t%s\t%s\t%s\t%s\t%s\n" "\$session" "\$created" "\$windows" "\$attached" "\$cwd" "existing session"
    exit 0
  fi
  echo "__ERROR__\tSession already exists: \$session"
  exit 0
fi
safe_cmd="cd "\$cwd" && { \$cmd; }; exec bash"
tmux new-session -d -s "\$session" -c "\$cwd" "bash -lc \$(printf %q "\$safe_cmd")" >/dev/null 2>&1
printf "%s\t%s\n" "\$cwd" "\$cmd" > "\$HOME/.ssh_dashboard/tmux_meta/\$session.tsv"
created="\$(tmux display-message -p -t "\$session" '#{session_created}' 2>/dev/null || echo '')"
windows="\$(tmux display-message -p -t "\$session" '#{session_windows}' 2>/dev/null || echo '')"
attached="\$(tmux display-message -p -t "\$session" '#{session_attached}' 2>/dev/null || echo '')"
printf "__TMUX__\t%s\t%s\t%s\t%s\t%s\t%s\n" "\$session" "\$created" "\$windows" "\$attached" "\$cwd" "\$cmd"
''',
      timeout: const Duration(seconds: 10),
    );
    for (final line in const LineSplitter().convert(output)) {
      if (line.startsWith('__ERROR__\t')) {
        final parts = line.split('\t');
        throw Exception(parts.length > 1 ? parts.sublist(1).join('\t') : 'tmux start failed');
      }
      if (line.startsWith('__TMUX__\t')) {
        return HermesTmuxSessionInfo.fromTsv(line.substring('__TMUX__\t'.length));
      }
    }
    throw Exception(output.trim().isEmpty ? 'tmux start returned no status' : output.trim());
  }

  Future<String> sendHermesTmuxInput({
    required String sessionName,
    required String text,
    bool pressEnter = true,
  }) async {
    final session = HermesRemoteCommandPolicy.normalizeSessionName(sessionName);
    final enter = pressEnter ? 'Enter' : '';
    final output = await _run(
      '''
if ! tmux has-session -t ${_quoteShellArg(session)} 2>/dev/null; then
  echo "__ERROR__\tSession not found: $session"
  exit 0
fi
tmux send-keys -t ${_quoteShellArg(session)} -- ${_quoteShellArg(text)} $enter
printf "__OK__\t%s\n" ${_quoteShellArg(session)}
''',
      timeout: const Duration(seconds: 5),
    );
    if (output.startsWith('__ERROR__')) {
      final parts = output.split('\t');
      throw Exception(parts.length > 1 ? parts[1] : 'tmux send failed');
    }
    return output.trim();
  }

  Future<String> captureHermesTmuxSession({
    required String sessionName,
    int lines = 160,
  }) async {
    final session = HermesRemoteCommandPolicy.normalizeSessionName(sessionName);
    final clamped = lines.clamp(20, 500).toInt();
    return _run(
      '''
if ! tmux has-session -t ${_quoteShellArg(session)} 2>/dev/null; then
  echo "__ERROR__\tSession not found: $session"
  exit 0
fi
tmux capture-pane -p -J -t ${_quoteShellArg(session)} -S -$clamped
''',
      timeout: const Duration(seconds: 5),
    );
  }

  Future<String> stopHermesTmuxSession(String sessionName) async {
    final session = HermesRemoteCommandPolicy.normalizeSessionName(sessionName);
    return _run(
      '''
if tmux has-session -t ${_quoteShellArg(session)} 2>/dev/null; then
  tmux kill-session -t ${_quoteShellArg(session)}
  rm -f "\$HOME/.ssh_dashboard/tmux_meta/$session.tsv" 2>/dev/null || true
  echo "__OK__\tStopped $session"
else
  echo "__OK__\tSession not found: $session"
fi
''',
      timeout: const Duration(seconds: 5),
    );
  }

  @override
  void dispose() {
    _pollingTimer?.cancel();
    _agentIdleTimer?.cancel();
    _agentStdoutSub?.cancel();
    _agentStderrSub?.cancel();
    _agentSession?.close();
    _client?.close();
    super.dispose();
  }
}



class _GpuProcessMetadata {
  final String username;
  final int? runtimeSeconds;
  final String commandLine;

  const _GpuProcessMetadata({
    required this.username,
    required this.runtimeSeconds,
    required this.commandLine,
  });
}
