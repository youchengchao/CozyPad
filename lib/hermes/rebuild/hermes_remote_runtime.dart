part of cozypad;

/* =========================================================
   Hermes Dart Rebuild: remote runtime / tmux control plane

   This file intentionally replaces the old messaging-gateway assumption with
   a VS Code / Claude Code style remote control model:
   - the Windows/Flutter app remains the entry point;
   - the connected server receives a lightweight ~/.ssh_dashboard runtime;
   - tmux sessions keep work alive after the local app disconnects;
   - desktop/mobile clients can reconnect by listing/capturing tmux sessions.
========================================================= */

class HermesRemoteRuntimeInfo {
  final bool ok;
  final String home;
  final String binDir;
  final bool tmuxAvailable;
  final bool pythonAvailable;
  final bool gitAvailable;
  final String tmuxVersion;
  final String message;

  const HermesRemoteRuntimeInfo({
    required this.ok,
    required this.home,
    required this.binDir,
    required this.tmuxAvailable,
    required this.pythonAvailable,
    required this.gitAvailable,
    required this.tmuxVersion,
    required this.message,
  });

  factory HermesRemoteRuntimeInfo.fromJson(Map<String, dynamic> json) {
    return HermesRemoteRuntimeInfo(
      ok: json['ok'] == true,
      home: json['home']?.toString() ?? '~/.ssh_dashboard',
      binDir: json['bin_dir']?.toString() ?? '~/.ssh_dashboard/bin',
      tmuxAvailable: json['tmux_available'] == true,
      pythonAvailable: json['python_available'] == true,
      gitAvailable: json['git_available'] == true,
      tmuxVersion: json['tmux_version']?.toString() ?? '',
      message: json['message']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() => {
        'ok': ok,
        'home': home,
        'bin_dir': binDir,
        'tmux_available': tmuxAvailable,
        'python_available': pythonAvailable,
        'git_available': gitAvailable,
        'tmux_version': tmuxVersion,
        'message': message,
      };
}

class HermesTmuxSessionInfo {
  final String name;
  final String created;
  final String windows;
  final String attached;
  final String cwd;
  final String command;

  const HermesTmuxSessionInfo({
    required this.name,
    required this.created,
    required this.windows,
    required this.attached,
    required this.cwd,
    required this.command,
  });

  factory HermesTmuxSessionInfo.fromTsv(String line) {
    final parts = line.split('\t');
    return HermesTmuxSessionInfo(
      name: parts.isNotEmpty ? parts[0] : '',
      created: parts.length > 1 ? parts[1] : '',
      windows: parts.length > 2 ? parts[2] : '',
      attached: parts.length > 3 ? parts[3] : '',
      cwd: parts.length > 4 ? parts[4] : '',
      command: parts.length > 5 ? parts.sublist(5).join('\t') : '',
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'created': created,
        'windows': windows,
        'attached': attached,
        'cwd': cwd,
        'command': command,
      };
}

class HermesRemoteCommandPolicy {
  static const Set<String> mutatingVerbs = {
    'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'kill', 'pkill', 'killall',
    'sudo', 'su', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'pip', 'pip3',
    'conda', 'mamba', 'uv', 'uvx', 'npm', 'pnpm', 'yarn', 'git', 'curl',
    'wget', 'bash', 'sh', 'python', 'python3', 'tmux', 'screen', 'nohup',
  };

  static bool looksDestructive(String command) {
    final clean = command.trim().toLowerCase();
    if (clean.isEmpty) return false;
    if (RegExp(r'(>|>>|\btee\b|\|\s*(sh|bash|python|python3)\b)').hasMatch(clean)) return true;
    if (RegExp(r'\b(rm\s+-[^\n]*r|rm\s+-rf|mkfs|dd\s+if=|mkfs|shutdown|reboot|fork bomb)').hasMatch(clean)) return true;
    return mutatingVerbs.any((verb) => RegExp('(^|[;&|()\\s])${RegExp.escape(verb)}([;&|()\\s]|\$)').hasMatch(clean));
  }

  static bool isInstallOrRuntimeCommand(String command) {
    final clean = command.trim().toLowerCase();
    return clean.contains('tmux') ||
        clean.contains('pip') ||
        clean.contains('conda') ||
        clean.contains('uv ') ||
        clean.contains('git clone') ||
        clean.contains('apt-get') ||
        clean.contains('apt ');
  }

  static String normalizeSessionName(String value) {
    final clean = value.trim().isEmpty ? 'hermes' : value.trim();
    final safe = clean.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]+'), '_');
    final bounded = safe.length > 48 ? safe.substring(0, 48) : safe;
    return bounded.startsWith('sdh_') ? bounded : 'sdh_$bounded';
  }
}

class HermesSyncManager {
  final HermesSessionStore sessionStore;
  final HermesMemoryStore memoryStore;

  HermesSyncManager({
    required this.sessionStore,
    required this.memoryStore,
  });

  Future<void> syncFromRemote(SSHProvider provider) async {
    if (!provider.isConnected) return;
    final connectedHost = provider.connectedHost;
    if (connectedHost == null) return;

    // Migrate remote legacy memory paths if they exist and secure remote folders
    try {
      await provider.runRemoteShell(
        'mkdir -p ~/.ssh_dashboard/memory/general && '
        'chmod -R 700 ~/.ssh_dashboard 2>/dev/null || chmod 700 ~/.ssh_dashboard && '
        'if [ -f ~/.ssh_dashboard/memory/USER.md ] && [ ! -f ~/.ssh_dashboard/memory/general/USER.md ]; then mv ~/.ssh_dashboard/memory/USER.md ~/.ssh_dashboard/memory/general/USER.md; fi && '
        'if [ -f ~/.ssh_dashboard/memory/MEMORY.md ] && [ ! -f ~/.ssh_dashboard/memory/general/MEMORY.md ]; then mv ~/.ssh_dashboard/memory/MEMORY.md ~/.ssh_dashboard/memory/general/MEMORY.md; fi'
      );
    } catch (_) {}

    final session = sessionStore.activeSession;
    if (session != null) {
      final remotePath = _remoteSessionPath(session.profile, session.project, session.id);
      try {
        final remoteContent = await provider.readRemoteFile(remotePath);
        if (remoteContent.trim().isNotEmpty) {
          final remoteSession = HermesSession.fromJson(jsonDecode(remoteContent));
          if (session.messages.length < remoteSession.messages.length) {
            sessionStore.activeSession = remoteSession;
            await sessionStore.save();
          }
        }
      } catch (_) {
        if (session.id == 'default') {
          try {
            final legacyPath = '~/.ssh_dashboard/sessions/${_safeName(session.profile)}/${_safeName(session.project)}/default_session.json';
            final remoteContent = await provider.readRemoteFile(legacyPath);
            if (remoteContent.trim().isNotEmpty) {
              final remoteSession = HermesSession.fromJson(jsonDecode(remoteContent));
              if (session.messages.length < remoteSession.messages.length) {
                sessionStore.activeSession = remoteSession;
                await sessionStore.save();
              }
            }
          } catch (_) {}
        }
      }
    }

    if (session != null) {
      try {
        final safeProfile = _safeName(session.profile);
        final safeProject = _safeName(session.project);
        final remoteDir = '~/.ssh_dashboard/sessions/$safeProfile/$safeProject';
        final remoteFileListRaw = await provider.runRemoteShell('ls -1 $remoteDir/ 2>/dev/null || true');
        final remoteFiles = remoteFileListRaw
            .split('\n')
            .map((line) => line.trim())
            .where((line) => line.isNotEmpty && line.endsWith('.json'))
            .toList();

        for (final fileName in remoteFiles) {
          if (fileName == 'default_session.json') continue;
          final remotePath = '$remoteDir/$fileName';
          final localFile = io.File('${sessionStore._sessionDir(session.profile, session.project, connectedHost: provider.connectedHost).path}/$fileName');
          final remoteContent = await provider.readRemoteFile(remotePath);
          if (remoteContent.trim().isNotEmpty) {
            bool shouldWrite = true;
            if (await localFile.exists()) {
              final localContent = await localFile.readAsString();
              final localSession = HermesSession.fromJson(jsonDecode(localContent));
              final remoteSession = HermesSession.fromJson(jsonDecode(remoteContent));
              if (localSession.messages.length >= remoteSession.messages.length) {
                shouldWrite = false;
              }
            }
            if (shouldWrite) {
              await localFile.parent.create(recursive: true);
              await localFile.writeAsString(remoteContent, flush: true);
            }
          }
        }
      } catch (_) {}
    }

    await _syncMemoryFile(provider, 'user');
    await _syncMemoryFile(provider, 'general');
    await _syncMemoryFile(provider, 'memory');
    await _syncKnowledgeBase(provider);
    await _syncSkillsFromRemote(provider);
  }

  Future<void> syncToRemote(SSHProvider provider) async {
    if (!provider.isConnected) return;

    final session = sessionStore.activeSession;
    if (session != null) {
      final remotePath = _remoteSessionPath(session.profile, session.project, session.id);
      try {
        final localFile = sessionStore._sessionFile(session.profile, session.project, session.id, connectedHost: provider.connectedHost);
        if (await localFile.exists()) {
          final localContent = await localFile.readAsString();
          final remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
          await provider.runRemoteShell('mkdir -p "$remoteDir"');
          await provider.writeRemoteFile(remotePath, localContent);
        }
      } catch (_) {}
    }

    await _syncMemoryFile(provider, 'user');
    await _syncMemoryFile(provider, 'general');
    await _syncMemoryFile(provider, 'memory');
    await _syncKnowledgeBase(provider);
    await _syncSkillsToRemote(provider);
  }

  Future<void> _syncMemoryFile(SSHProvider provider, String target) async {
    final remotePath = _remoteMemoryPath(target);
    final localFile = memoryStore._memoryFile(target);

    try {
      final remotePathEscaped = remotePath.replaceAll('~/', '\$HOME/');
      final cmd = 'stat -c %Y "$remotePathEscaped" 2>/dev/null || stat -f %m "$remotePathEscaped" 2>/dev/null || date +%s -r "$remotePathEscaped" 2>/dev/null || echo 0';
      final output = await provider.runRemoteShell(cmd);
      final remoteTime = int.tryParse(output.trim()) ?? 0;

      int localTime = 0;
      if (await localFile.exists()) {
        localTime = localFile.lastModifiedSync().millisecondsSinceEpoch ~/ 1000;
      }

      if (localTime > 0 && remoteTime > 0) {
        final localContent = await localFile.readAsString();
        final remoteContent = await provider.readRemoteFile(remotePath);
        if (localContent.trim() == remoteContent.trim()) {
          if (localTime != remoteTime) {
            try {
              await localFile.setLastModified(DateTime.fromMillisecondsSinceEpoch(remoteTime * 1000));
            } catch (_) {}
          }
          return;
        }
      }

      if (remoteTime > localTime) {
        final remoteContent = await provider.readRemoteFile(remotePath);
        if (remoteContent.trim().isNotEmpty) {
          await localFile.parent.create(recursive: true);
          await localFile.writeAsString(remoteContent, flush: true);
          try {
            await localFile.setLastModified(DateTime.fromMillisecondsSinceEpoch(remoteTime * 1000));
          } catch (_) {}
        }
      } else if (localTime > remoteTime) {
        if (await localFile.exists()) {
          final localContent = await localFile.readAsString();
          final remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
          await provider.runRemoteShell('mkdir -p "$remoteDir" && chmod 700 "$remoteDir"');
          await provider.writeRemoteFile(remotePath, localContent);
          try {
            await provider.runRemoteShell('touch -d "@$localTime" "$remotePathEscaped" 2>/dev/null || touch -t \$(date -r $localTime +%Y%m%d%H%M.%S 2>/dev/null || echo "") "$remotePathEscaped" 2>/dev/null || true');
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  Future<void> _syncKnowledgeBase(SSHProvider provider) async {
    final safeProfile = _safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
    final safeProject = _safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
    final remoteDir = '~/.ssh_dashboard/memory/projects/$safeProfile/$safeProject/knowledge';
    final root = memoryStore._expandedHome(memoryStore.homePath);
    final localDir = io.Directory('$root/memories/projects/$safeProfile/$safeProject/knowledge');

    try {
      if (!await localDir.exists()) {
        await localDir.create(recursive: true);
      }
      await provider.runRemoteShell('mkdir -p "$remoteDir" && chmod 700 "$remoteDir"');

      // 1. List remote Markdown files
      final remoteFileListRaw = await provider.runRemoteShell('ls -1 $remoteDir/ 2>/dev/null || true');
      final remoteFiles = remoteFileListRaw
          .split('\n')
          .map((line) => line.trim())
          .where((line) => line.isNotEmpty && line.endsWith('.md'))
          .toList();

      // 2. List local Markdown files
      final localFiles = await localDir
          .list()
          .where((entity) => entity is io.File && entity.path.toLowerCase().endsWith('.md'))
          .cast<io.File>()
          .toList();

      final allFileNames = <String>{}
        ..addAll(remoteFiles)
        ..addAll(localFiles.map((f) => f.uri.pathSegments.last));

      // 3. For each file, run a two-way sync
      for (final fileName in allFileNames) {
        final remotePath = '$remoteDir/$fileName';
        final localFile = io.File('${localDir.path}/$fileName');
        final remotePathEscaped = remotePath.replaceAll('~/', '\$HOME/');

        // 3.1 Get remote mtime
        final cmd = 'stat -c %Y "$remotePathEscaped" 2>/dev/null || stat -f %m "$remotePathEscaped" 2>/dev/null || date +%s -r "$remotePathEscaped" 2>/dev/null || echo 0';
        final output = await provider.runRemoteShell(cmd);
        final remoteTime = int.tryParse(output.trim()) ?? 0;

        // 3.2 Get local mtime
        int localTime = 0;
        if (await localFile.exists()) {
          localTime = localFile.lastModifiedSync().millisecondsSinceEpoch ~/ 1000;
        }

        // 3.3 Check content equality
        if (localTime > 0 && remoteTime > 0) {
          final localContent = await localFile.readAsString();
          final remoteContent = await provider.readRemoteFile(remotePath);
          if (localContent.trim() == remoteContent.trim()) {
            if (localTime != remoteTime) {
              try {
                await localFile.setLastModified(DateTime.fromMillisecondsSinceEpoch(remoteTime * 1000));
              } catch (_) {}
            }
            continue;
          }
        }

        // 3.4 Sync based on mtime
        if (remoteTime > localTime) {
          final remoteContent = await provider.readRemoteFile(remotePath);
          if (remoteContent.trim().isNotEmpty) {
            await localFile.writeAsString(remoteContent, flush: true);
            try {
              await localFile.setLastModified(DateTime.fromMillisecondsSinceEpoch(remoteTime * 1000));
            } catch (_) {}
          }
        } else if (localTime > remoteTime) {
          if (await localFile.exists()) {
            final localContent = await localFile.readAsString();
            await provider.writeRemoteFile(remotePath, localContent);
            try {
              await provider.runRemoteShell('touch -d "@$localTime" "$remotePathEscaped" 2>/dev/null || touch -t \$(date -r $localTime +%Y%m%d%H%M.%S 2>/dev/null || echo "") "$remotePathEscaped" 2>/dev/null || true');
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  String _remoteSessionPath(String profile, String project, String sessionId) {
    final safeProfile = _safeName(profile.trim().isEmpty ? 'default' : profile.trim());
    final safeProject = _safeName(project.trim().isEmpty ? 'general' : project.trim());
    final safeSessionId = _safeName(sessionId.trim().isEmpty ? 'default' : sessionId.trim());
    return '~/.ssh_dashboard/sessions/$safeProfile/$safeProject/session_$safeSessionId.json';
  }

  String _remoteMemoryPath(String target) {
    final clean = target.trim().toLowerCase();
    final norm = clean == 'user' || clean == 'user_profile' || clean == 'profile'
        ? 'user'
        : (clean == 'general' || clean == 'global' || clean == 'common' ? 'general' : 'memory');

    if (norm == 'user') {
      return '~/.ssh_dashboard/memory/general/USER.md';
    } else if (norm == 'general') {
      return '~/.ssh_dashboard/memory/general/MEMORY.md';
    } else {
      final safeProfile = _safeName(memoryStore.profile.trim().isEmpty ? 'default' : memoryStore.profile.trim());
      final safeProject = _safeName(memoryStore.project.trim().isEmpty ? 'general' : memoryStore.project.trim());
      return '~/.ssh_dashboard/memory/projects/$safeProfile/$safeProject/MEMORY.md';
    }
  }

  Future<void> _syncSkillsFromRemote(SSHProvider provider) async {
    try {
      final remoteFileListRaw = await provider.runRemoteShell('ls -1 ~/.ssh_dashboard/skills/ 2>/dev/null || true');
      final remoteFiles = remoteFileListRaw
          .split('\n')
          .map((line) => line.trim())
          .where((line) => line.isNotEmpty && line.endsWith('.md'))
          .toList();

      final localHome = memoryStore._expandedHome(memoryStore.homePath);
      final localSkillsDir = io.Directory('$localHome/skills');
      if (!await localSkillsDir.exists()) {
        await localSkillsDir.create(recursive: true);
      }

      for (final fileName in remoteFiles) {
        final remotePath = '~/.ssh_dashboard/skills/$fileName';
        final localFile = io.File('${localSkillsDir.path}/$fileName');
        final remoteContent = await provider.readRemoteFile(remotePath);
        if (remoteContent.trim().isNotEmpty) {
          String localContent = '';
          if (await localFile.exists()) {
            localContent = await localFile.readAsString();
          }
          if (localContent.trim() != remoteContent.trim()) {
            await localFile.writeAsString(remoteContent, flush: true);
          }
        }
      }
    } catch (_) {}
  }

  Future<void> _syncSkillsToRemote(SSHProvider provider) async {
    try {
      final localHome = memoryStore._expandedHome(memoryStore.homePath);
      final localSkillsDir = io.Directory('$localHome/skills');
      if (await localSkillsDir.exists()) {
        final localFiles = await localSkillsDir
            .list()
            .where((entity) => entity is io.File && entity.path.toLowerCase().endsWith('.md'))
            .cast<io.File>()
            .toList();

        if (localFiles.isNotEmpty) {
          await provider.runRemoteShell('mkdir -p ~/.ssh_dashboard/skills/ && chmod 700 ~/.ssh_dashboard/skills/');
          for (final file in localFiles) {
            final fileName = file.uri.pathSegments.last;
            final remotePath = '~/.ssh_dashboard/skills/$fileName';
            final localContent = await file.readAsString();
            await provider.writeRemoteFile(remotePath, localContent);
          }
        }
      }
    } catch (_) {}
  }

  String _safeName(String value) {
    return value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '_');
  }
}
