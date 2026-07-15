part of ssh_dashboard;

/* =========================================================
   Models
========================================================= */

class ConnectionProfile {
  final String id;
  final String name;
  final String host;
  final int port;
  final String username;
  final String password;
  final bool autoLogin;

  ConnectionProfile({
    required this.id,
    required this.name,
    required this.host,
    required this.port,
    required this.username,
    required this.password,
    required this.autoLogin,
  });

  factory ConnectionProfile.fromJson(Map<String, dynamic> json) {
    return ConnectionProfile(
      id: json['id']?.toString() ??
          DateTime.now().millisecondsSinceEpoch.toString(),
      name: json['name']?.toString() ?? 'Unnamed',
      host: json['host']?.toString() ?? '',
      port: (json['port'] as num?)?.toInt() ?? 22,
      username: json['username']?.toString() ?? '',
      password: json['password']?.toString() ?? '',
      autoLogin: json['autoLogin'] == true,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'host': host,
      'port': port,
      'username': username,
      'password': password,
      'autoLogin': autoLogin,
    };
  }

  ConnectionProfile copyWith({
    String? id,
    String? name,
    String? host,
    int? port,
    String? username,
    String? password,
    bool? autoLogin,
  }) {
    return ConnectionProfile(
      id: id ?? this.id,
      name: name ?? this.name,
      host: host ?? this.host,
      port: port ?? this.port,
      username: username ?? this.username,
      password: password ?? this.password,
      autoLogin: autoLogin ?? this.autoLogin,
    );
  }
}

class AgentMessage {
  final String role; // user / assistant / system
  final String text;
  final DateTime time;

  AgentMessage({
    required this.role,
    required this.text,
    required this.time,
  });
}

class AgentSuggestion {
  final String label;
  final String description;
  final String insertText;

  const AgentSuggestion({
    required this.label,
    required this.description,
    required this.insertText,
  });
}


class AgentChoice {
  final String label;
  final String description;
  final String sendText;
  final bool useArrowNavigation;
  final int arrowDownCount;

  const AgentChoice({
    required this.label,
    required this.sendText,
    this.description = '',
    this.useArrowNavigation = false,
    this.arrowDownCount = 0,
  });
}

class RemoteFileItem {
  final String name;
  final String path;
  final String type;
  final int sizeBytes;
  final String modified;

  const RemoteFileItem({
    required this.name,
    required this.path,
    required this.type,
    required this.sizeBytes,
    required this.modified,
  });

  bool get isDirectory => type == 'd';
  bool get isSymlink => type == 'l';

  String get displayType {
    if (isDirectory) return 'Folder';
    if (isSymlink) return 'Symlink';
    return 'File';
  }
}

class RemoteDirectoryListing {
  final String path;
  final List<RemoteFileItem> items;

  const RemoteDirectoryListing({
    required this.path,
    required this.items,
  });
}

enum RemoteFilePreviewKind {
  none,
  text,
  markdown,
  image,
  video,
  binary,
  error,
}

class RemoteFilePreviewData {
  final RemoteFileItem? item;
  final RemoteFilePreviewKind kind;
  final String? text;
  final Uint8List? bytes;
  final String? mimeType;
  final String? message;
  final bool truncated;

  const RemoteFilePreviewData._({
    required this.item,
    required this.kind,
    this.text,
    this.bytes,
    this.mimeType,
    this.message,
    this.truncated = false,
  });

  const RemoteFilePreviewData.empty()
      : this._(item: null, kind: RemoteFilePreviewKind.none);

  const RemoteFilePreviewData.text({
    required RemoteFileItem item,
    required String text,
    bool truncated = false,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.text,
          text: text,
          truncated: truncated,
        );

  const RemoteFilePreviewData.markdown({
    required RemoteFileItem item,
    required String text,
    bool truncated = false,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.markdown,
          text: text,
          truncated: truncated,
        );

  const RemoteFilePreviewData.image({
    required RemoteFileItem item,
    required Uint8List bytes,
    required String mimeType,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.image,
          bytes: bytes,
          mimeType: mimeType,
        );

  const RemoteFilePreviewData.video({
    required RemoteFileItem item,
    required Uint8List bytes,
    required String mimeType,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.video,
          bytes: bytes,
          mimeType: mimeType,
        );

  const RemoteFilePreviewData.binary({
    required RemoteFileItem item,
    required String message,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.binary,
          message: message,
        );

  const RemoteFilePreviewData.error({
    required RemoteFileItem item,
    required String message,
  }) : this._(
          item: item,
          kind: RemoteFilePreviewKind.error,
          message: message,
        );
}

class CpuCoreMetric {
  final int index;
  final double usage;

  CpuCoreMetric({
    required this.index,
    required this.usage,
  });
}

class CpuMetric {
  final double totalUsage;
  final List<CpuCoreMetric> cores;

  CpuMetric({
    required this.totalUsage,
    required this.cores,
  });

  static CpuMetric empty() {
    return CpuMetric(totalUsage: 0, cores: []);
  }
}

class MemoryMetric {
  final double usedMb;
  final double totalMb;

  MemoryMetric({
    required this.usedMb,
    required this.totalMb,
  });

  double get usagePercent {
    if (totalMb <= 0) return 0;
    return usedMb / totalMb * 100;
  }

  static MemoryMetric empty() {
    return MemoryMetric(usedMb: 0, totalMb: 0);
  }
}

class GpuProcessMetric {
  final int pid;
  final String username;
  final String processName;
  final String commandLine;
  final double usedMemoryMb;
  final int? runtimeSeconds;

  const GpuProcessMetric({
    required this.pid,
    required this.username,
    required this.processName,
    required this.commandLine,
    required this.usedMemoryMb,
    this.runtimeSeconds,
  });

  String get shortName {
    final slash = processName.lastIndexOf('/');
    return slash >= 0 ? processName.substring(slash + 1) : processName;
  }

  String get displayCommand {
    final text = commandLine.trim();
    if (text.isNotEmpty) return text;
    return shortName;
  }

  String get runtimeLabel {
    final seconds = runtimeSeconds;
    if (seconds == null || seconds < 0) return 'runtime unknown';

    final days = seconds ~/ 86400;
    final hours = (seconds % 86400) ~/ 3600;
    final minutes = (seconds % 3600) ~/ 60;

    if (days > 0) return '${days}d ${hours}h';
    if (hours > 0) return '${hours}h ${minutes}m';
    if (minutes > 0) return '${minutes}m';
    return '${seconds}s';
  }
}

class GpuMetric {
  final int index;
  final String uuid;
  final String name;
  final double usage;
  final double memoryUsedMb;
  final double memoryTotalMb;
  final double temperature;
  final List<GpuProcessMetric> processes;

  GpuMetric({
    required this.index,
    required this.uuid,
    required this.name,
    required this.usage,
    required this.memoryUsedMb,
    required this.memoryTotalMb,
    required this.temperature,
    this.processes = const [],
  });

  int get processCount => processes.length;

  double get memoryUsagePercent {
    if (memoryTotalMb <= 0) return 0;
    return memoryUsedMb / memoryTotalMb * 100;
  }
}

class TaskItem {
  final String id;
  final String title;
  final String status;
  final String detail;
  final String? agentName;
  final String? agentCommand;
  final String? cwd;
  final String? prompt;
  final String? kind;
  final String? launchMode;
  final String? command;
  final String? scheduledAt;
  final String? createdAt;
  final int? targetGpuIndex;
  final int? maxGpuMemoryMb;
  final int? maxGpuUtilization;
  final int? requiredIdleSeconds;
  final int? pid;
  final String? logPath;
  final String? lastStartedAt;

  TaskItem({
    String? id,
    required this.title,
    required this.status,
    required this.detail,
    this.agentName,
    this.agentCommand,
    this.cwd,
    this.prompt,
    this.kind,
    this.launchMode,
    this.command,
    this.scheduledAt,
    this.createdAt,
    this.targetGpuIndex,
    this.maxGpuMemoryMb,
    this.maxGpuUtilization,
    this.requiredIdleSeconds,
    this.pid,
    this.logPath,
    this.lastStartedAt,
  }) : id = id ?? DateTime.now().microsecondsSinceEpoch.toString();

  factory TaskItem.fromJson(dynamic raw, int index) {
    String? clean(dynamic value) {
      final text = value?.toString().trim();
      if (text == null || text.isEmpty) return null;
      return text;
    }

    int? cleanInt(dynamic value) {
      if (value == null) return null;
      if (value is num) return value.toInt();
      return int.tryParse(value.toString().trim());
    }

    if (raw is Map) {
      final id = clean(raw['id'] ?? raw['taskId'] ?? raw['task_id']) ??
          DateTime.now().microsecondsSinceEpoch.toString();
      final title = raw['title'] ??
          raw['name'] ??
          raw['task'] ??
          raw['id'] ??
          'Task ${index + 1}';

      final status = raw['status'] ?? raw['state'] ?? 'Unknown';

      final command = clean(raw['command'] ?? raw['cmd'] ?? raw['launchCommand'] ?? raw['launch_command']);

      final detail = raw['detail'] ??
          raw['description'] ??
          raw['message'] ??
          command ??
          '';

      String? agentName;
      String? agentCommand;
      final agentRaw = raw['agent'] ?? raw['agentName'] ?? raw['agent_name'];
      if (agentRaw is Map) {
        agentName = clean(agentRaw['name'] ?? agentRaw['label']);
        agentCommand = clean(agentRaw['command'] ?? agentRaw['cmd'] ?? agentRaw['launcher']);
      } else {
        agentName = clean(agentRaw);
      }

      agentName ??= clean(raw['model'] ?? raw['assistant']);
      agentCommand ??= clean(
        raw['agentCommand'] ??
            raw['agent_command'] ??
            raw['launcherCommand'] ??
            raw['launcher_command'],
      );

      return TaskItem(
        id: id,
        title: title.toString(),
        status: status.toString(),
        detail: detail.toString(),
        agentName: agentName,
        agentCommand: agentCommand,
        cwd: clean(raw['cwd'] ?? raw['path'] ?? raw['workingDirectory'] ?? raw['working_directory']),
        prompt: clean(raw['prompt'] ?? raw['instruction'] ?? raw['instructions']),
        kind: clean(raw['kind'] ?? raw['type']),
        launchMode: clean(raw['launchMode'] ?? raw['launch_mode'] ?? raw['mode']),
        command: command,
        scheduledAt: clean(raw['scheduledAt'] ?? raw['scheduled_at'] ?? raw['runAt'] ?? raw['run_at']),
        createdAt: clean(raw['createdAt'] ?? raw['created_at']),
        targetGpuIndex: cleanInt(raw['targetGpuIndex'] ?? raw['target_gpu_index'] ?? raw['gpu']),
        maxGpuMemoryMb: cleanInt(raw['maxGpuMemoryMb'] ?? raw['max_gpu_memory_mb']),
        maxGpuUtilization: cleanInt(raw['maxGpuUtilization'] ?? raw['max_gpu_utilization']),
        requiredIdleSeconds: cleanInt(raw['requiredIdleSeconds'] ?? raw['required_idle_seconds']),
        pid: cleanInt(raw['pid']),
        logPath: clean(raw['logPath'] ?? raw['log_path']),
        lastStartedAt: clean(raw['lastStartedAt'] ?? raw['last_started_at']),
      );
    }

    return TaskItem(
      title: 'Task ${index + 1}',
      status: 'Unknown',
      detail: raw.toString(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'status': status,
      'detail': detail,
      if (agentName != null) 'agentName': agentName,
      if (agentCommand != null) 'agentCommand': agentCommand,
      if (cwd != null) 'cwd': cwd,
      if (prompt != null) 'prompt': prompt,
      if (kind != null) 'kind': kind,
      if (launchMode != null) 'launchMode': launchMode,
      if (command != null) 'command': command,
      if (scheduledAt != null) 'scheduledAt': scheduledAt,
      if (createdAt != null) 'createdAt': createdAt,
      if (targetGpuIndex != null) 'targetGpuIndex': targetGpuIndex,
      if (maxGpuMemoryMb != null) 'maxGpuMemoryMb': maxGpuMemoryMb,
      if (maxGpuUtilization != null) 'maxGpuUtilization': maxGpuUtilization,
      if (requiredIdleSeconds != null) 'requiredIdleSeconds': requiredIdleSeconds,
      if (pid != null) 'pid': pid,
      if (logPath != null) 'logPath': logPath,
      if (lastStartedAt != null) 'lastStartedAt': lastStartedAt,
    };
  }

  TaskItem copyWith({
    String? id,
    String? title,
    String? status,
    String? detail,
    String? agentName,
    String? agentCommand,
    String? cwd,
    String? prompt,
    String? kind,
    String? launchMode,
    String? command,
    String? scheduledAt,
    String? createdAt,
    int? targetGpuIndex,
    int? maxGpuMemoryMb,
    int? maxGpuUtilization,
    int? requiredIdleSeconds,
    int? pid,
    String? logPath,
    String? lastStartedAt,
  }) {
    return TaskItem(
      id: id ?? this.id,
      title: title ?? this.title,
      status: status ?? this.status,
      detail: detail ?? this.detail,
      agentName: agentName ?? this.agentName,
      agentCommand: agentCommand ?? this.agentCommand,
      cwd: cwd ?? this.cwd,
      prompt: prompt ?? this.prompt,
      kind: kind ?? this.kind,
      launchMode: launchMode ?? this.launchMode,
      command: command ?? this.command,
      scheduledAt: scheduledAt ?? this.scheduledAt,
      createdAt: createdAt ?? this.createdAt,
      targetGpuIndex: targetGpuIndex ?? this.targetGpuIndex,
      maxGpuMemoryMb: maxGpuMemoryMb ?? this.maxGpuMemoryMb,
      maxGpuUtilization: maxGpuUtilization ?? this.maxGpuUtilization,
      requiredIdleSeconds: requiredIdleSeconds ?? this.requiredIdleSeconds,
      pid: pid ?? this.pid,
      logPath: logPath ?? this.logPath,
      lastStartedAt: lastStartedAt ?? this.lastStartedAt,
    );
  }

  String get effectiveAgentName {
    final name = agentName?.trim();
    if (name != null && name.isNotEmpty) return name;
    return 'Codex';
  }

  String get effectivePrompt {
    final explicitPrompt = prompt?.trim();
    if (explicitPrompt != null && explicitPrompt.isNotEmpty) {
      return explicitPrompt;
    }

    final buffer = StringBuffer('Task: $title');
    final cleanDetail = detail.trim();
    if (cleanDetail.isNotEmpty) {
      buffer.write('\n\nContext:\n$cleanDetail');
    }
    final cleanCommand = command?.trim();
    if (cleanCommand != null && cleanCommand.isNotEmpty) {
      buffer.write('\n\nCommand:\n$cleanCommand');
    }
    if (cwd?.trim().isNotEmpty ?? false) {
      buffer.write('\n\nWorking directory:\n${cwd!.trim()}');
    }
    return buffer.toString();
  }

  bool get hasAgentMetadata {
    return (agentName?.trim().isNotEmpty ?? false) ||
        (agentCommand?.trim().isNotEmpty ?? false) ||
        (cwd?.trim().isNotEmpty ?? false) ||
        (prompt?.trim().isNotEmpty ?? false);
  }

  bool get hasLaunchCommand => command?.trim().isNotEmpty ?? false;

  bool get isRunning => status.toLowerCase().contains('running');

  bool get isTerminalState {
    final s = status.toLowerCase();
    return s.contains('complete') ||
        s.contains('done') ||
        s.contains('cancel') ||
        s.contains('fail') ||
        s.contains('error');
  }

  String get displayLaunchMode {
    switch ((launchMode ?? '').toLowerCase()) {
      case 'manual':
        return 'Manual';
      case 'wait_for_idle':
        return 'Wait for GPU';
      case 'scheduled':
        return 'Scheduled';
      default:
        return launchMode ?? 'Task';
    }
  }
}

class SavedCredentials {
  final String host;
  final int port;
  final String username;
  final String password;
  final bool autoLogin;

  SavedCredentials({
    required this.host,
    required this.port,
    required this.username,
    required this.password,
    required this.autoLogin,
  });
}

class _CpuStat {
  final int user;
  final int nice;
  final int system;
  final int idle;
  final int iowait;
  final int irq;
  final int softirq;
  final int steal;

  _CpuStat({
    required this.user,
    required this.nice,
    required this.system,
    required this.idle,
    required this.iowait,
    required this.irq,
    required this.softirq,
    required this.steal,
  });

  int get idleAll => idle + iowait;

  int get nonIdle => user + nice + system + irq + softirq + steal;

  int get total => idleAll + nonIdle;
}

/* =========================================================
   Project Management Models
   ========================================================= */

class ProjectCodebaseState {
  final String connectionId;
  final String remotePath;
  final String lastActiveAt;   // ISO 8601 String
  final String lastSyncAt;     // ISO 8601 String
  final String codebaseUpdatedAt; // ISO 8601 String

  ProjectCodebaseState({
    required this.connectionId,
    required this.remotePath,
    required this.lastActiveAt,
    required this.lastSyncAt,
    required this.codebaseUpdatedAt,
  });

  factory ProjectCodebaseState.fromJson(Map<String, dynamic> json) {
    return ProjectCodebaseState(
      connectionId: json['connectionId']?.toString() ?? '',
      remotePath: json['remotePath']?.toString() ?? '',
      lastActiveAt: json['lastActiveAt']?.toString() ?? '',
      lastSyncAt: json['lastSyncAt']?.toString() ?? '',
      codebaseUpdatedAt: json['codebaseUpdatedAt']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'connectionId': connectionId,
      'remotePath': remotePath,
      'lastActiveAt': lastActiveAt,
      'lastSyncAt': lastSyncAt,
      'codebaseUpdatedAt': codebaseUpdatedAt,
    };
  }

  ProjectCodebaseState copyWith({
    String? connectionId,
    String? remotePath,
    String? lastActiveAt,
    String? lastSyncAt,
    String? codebaseUpdatedAt,
  }) {
    return ProjectCodebaseState(
      connectionId: connectionId ?? this.connectionId,
      remotePath: remotePath ?? this.remotePath,
      lastActiveAt: lastActiveAt ?? this.lastActiveAt,
      lastSyncAt: lastSyncAt ?? this.lastSyncAt,
      codebaseUpdatedAt: codebaseUpdatedAt ?? this.codebaseUpdatedAt,
    );
  }
}

class ProjectTransferRecord {
  final String? fromConnectionId;
  final String toConnectionId;
  final String fromPath;
  final String toPath;
  final String timestamp; // ISO 8601 String

  ProjectTransferRecord({
    this.fromConnectionId,
    required this.toConnectionId,
    required this.fromPath,
    required this.toPath,
    required this.timestamp,
  });

  factory ProjectTransferRecord.fromJson(Map<String, dynamic> json) {
    return ProjectTransferRecord(
      fromConnectionId: json['fromConnectionId']?.toString(),
      toConnectionId: json['toConnectionId']?.toString() ?? '',
      fromPath: json['fromPath']?.toString() ?? '',
      toPath: json['toPath']?.toString() ?? '',
      timestamp: json['timestamp']?.toString() ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      if (fromConnectionId != null) 'fromConnectionId': fromConnectionId,
      'toConnectionId': toConnectionId,
      'fromPath': fromPath,
      'toPath': toPath,
      'timestamp': timestamp,
    };
  }
}

class ProjectProfile {
  final String id;
  final String name;
  final String description;
  final String createdAt; // ISO 8601 String
  final Map<String, ProjectCodebaseState> codebaseStates; // key: connectionId
  final List<ProjectTransferRecord> transferHistory;

  ProjectProfile({
    required this.id,
    required this.name,
    this.description = '',
    required this.createdAt,
    this.codebaseStates = const {},
    this.transferHistory = const [],
  });

  factory ProjectProfile.fromJson(Map<String, dynamic> json) {
    final codebaseMap = <String, ProjectCodebaseState>{};
    if (json['codebaseStates'] is Map) {
      (json['codebaseStates'] as Map).forEach((k, v) {
        if (v is Map) {
          codebaseMap[k.toString()] = ProjectCodebaseState.fromJson(Map<String, dynamic>.from(v));
        }
      });
    }

    final historyList = <ProjectTransferRecord>[];
    if (json['transferHistory'] is List) {
      for (final item in json['transferHistory']) {
        if (item is Map) {
          historyList.add(ProjectTransferRecord.fromJson(Map<String, dynamic>.from(item)));
        }
      }
    }

    return ProjectProfile(
      id: json['id']?.toString() ?? DateTime.now().millisecondsSinceEpoch.toString(),
      name: json['name']?.toString() ?? 'Unnamed Project',
      description: json['description']?.toString() ?? '',
      createdAt: json['createdAt']?.toString() ?? DateTime.now().toIso8601String(),
      codebaseStates: codebaseMap,
      transferHistory: historyList,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'createdAt': createdAt,
      'codebaseStates': codebaseStates.map((k, v) => MapEntry(k, v.toJson())),
      'transferHistory': transferHistory.map((e) => e.toJson()).toList(),
    };
  }

  ProjectProfile copyWith({
    String? id,
    String? name,
    String? description,
    String? createdAt,
    Map<String, ProjectCodebaseState>? codebaseStates,
    List<ProjectTransferRecord>? transferHistory,
  }) {
    return ProjectProfile(
      id: id ?? this.id,
      name: name ?? this.name,
      description: description ?? this.description,
      createdAt: createdAt ?? this.createdAt,
      codebaseStates: codebaseStates ?? this.codebaseStates,
      transferHistory: transferHistory ?? this.transferHistory,
    );
  }
}


