part of cozypad;

class _ConnectionProfileCard extends StatelessWidget {
  final ConnectionProfile profile;
  final bool connecting;
  final VoidCallback onTap;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  const _ConnectionProfileCard({
    required this.profile,
    required this.connecting,
    required this.onTap,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () async {
          final action = await showDialog<String>(
            context: context,
            builder: (_) => _ConnectionProfileDetailsDialog(profile: profile),
          );

          if (action == 'connect') onTap();
          if (action == 'edit') onEdit();
          if (action == 'delete') onDelete();
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              Icon(
                profile.autoLogin ? Icons.flash_on : Icons.dns,
                size: 16,
                color: profile.autoLogin ? AppPalette.success : AppPalette.textSecondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  profile.name.isEmpty ? profile.host : profile.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (connecting)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(Icons.chevron_right, size: 18, color: AppPalette.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}

class _ConnectionProfileDetailsDialog extends StatelessWidget {
  final ConnectionProfile profile;

  const _ConnectionProfileDetailsDialog({required this.profile});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(profile.name.isEmpty ? 'Connection' : profile.name),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _DetailRow(label: 'IP', value: profile.host),
          _DetailRow(label: 'Port', value: profile.port.toString()),
          _DetailRow(label: '使用者', value: profile.username),
          _DetailRow(label: 'Auto login', value: profile.autoLogin ? 'Yes' : 'No'),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop('delete'),
          child: const Text('Delete'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop('edit'),
          child: const Text('Edit'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop('connect'),
          child: const Text('Connect'),
        ),
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;

  const _DetailRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 78,
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
            ),
          ),
          Expanded(
            child: SelectableText(value.isEmpty ? '-' : value),
          ),
        ],
      ),
    );
  }
}

class _ProfileLine extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _ProfileLine({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15, color: AppPalette.textSecondary),
        const SizedBox(width: 6),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: AppPalette.textMuted,
                    ),
              ),
              const SizedBox(height: 1),
              Text(
                value.isEmpty ? '-' : value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class ProfileEditorDialog extends StatefulWidget {
  final ConnectionProfile? profile;

  const ProfileEditorDialog({super.key, this.profile});

  @override
  State<ProfileEditorDialog> createState() => _ProfileEditorDialogState();
}

class _ProfileEditorDialogState extends State<ProfileEditorDialog> {
  late final TextEditingController nameController;
  late final TextEditingController hostController;
  late final TextEditingController portController;
  late final TextEditingController usernameController;
  late final TextEditingController passwordController;
  bool autoLogin = false;

  @override
  void initState() {
    super.initState();
    final p = widget.profile;
    nameController = TextEditingController(text: p?.name ?? '');
    hostController = TextEditingController(text: p?.host ?? '');
    portController = TextEditingController(text: (p?.port ?? 22).toString());
    usernameController = TextEditingController(text: p?.username ?? '');
    passwordController = TextEditingController(text: p?.password ?? '');
    autoLogin = p?.autoLogin ?? false;
  }

  @override
  void dispose() {
    nameController.dispose();
    hostController.dispose();
    portController.dispose();
    usernameController.dispose();
    passwordController.dispose();
    super.dispose();
  }

  void save() {
    final profile = ConnectionProfile(
      id: widget.profile?.id ?? DateTime.now().millisecondsSinceEpoch.toString(),
      name: nameController.text.trim(),
      host: hostController.text.trim(),
      port: int.tryParse(portController.text.trim()) ?? 22,
      username: usernameController.text.trim(),
      password: passwordController.text,
      autoLogin: autoLogin,
    );

    if (profile.name.isEmpty ||
        profile.host.isEmpty ||
        profile.username.isEmpty ||
        profile.password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('請完整填寫名稱、Host、Username、Password')),
      );
      return;
    }

    Navigator.of(context).pop(profile);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.profile == null ? '新增連線' : '編輯連線'),
      content: SingleChildScrollView(
        child: SizedBox(
          width: 360,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameController,
                decoration: InputDecoration(labelText: '顯示名稱'),
              ),
              TextField(
                controller: hostController,
                decoration: InputDecoration(labelText: 'Host / IP'),
              ),
              TextField(
                controller: portController,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(labelText: 'Port'),
              ),
              TextField(
                controller: usernameController,
                decoration: InputDecoration(labelText: 'Username'),
              ),
              TextField(
                controller: passwordController,
                obscureText: true,
                decoration: InputDecoration(labelText: 'Password'),
              ),
              SwitchListTile(
                value: autoLogin,
                contentPadding: EdgeInsets.zero,
                title: const Text('自動登入'),
                onChanged: (value) {
                  setState(() {
                    autoLogin = value;
                  });
                },
              ),
            ],
          ),
        ),
      ),
      actions: [
        if (widget.profile != null)
          TextButton(
            onPressed: () async {
              final confirm = await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('刪除連線'),
                  content: Text('確定要刪除「${widget.profile!.name.isEmpty ? widget.profile!.host : widget.profile!.name}」嗎？'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(false),
                      child: const Text('取消'),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.of(context).pop(true),
                      style: FilledButton.styleFrom(
                        backgroundColor: AppPalette.danger,
                        foregroundColor: Colors.white,
                      ),
                      child: const Text('刪除'),
                    ),
                  ],
                ),
              );
              if (confirm == true) {
                if (context.mounted) {
                  Navigator.of(context).pop('delete');
                }
              }
            },
            style: TextButton.styleFrom(foregroundColor: AppPalette.danger),
            child: const Text('刪除連線'),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: save,
          child: const Text('儲存'),
        ),
      ],
    );
  }
}

/* =========================================================
   Project UI Dialogs
   ========================================================= */

class ProjectEditorDialog extends StatefulWidget {
  final ProjectProfile? project;

  const ProjectEditorDialog({super.key, this.project});

  @override
  State<ProjectEditorDialog> createState() => _ProjectEditorDialogState();
}

class _ProjectEditorDialogState extends State<ProjectEditorDialog> {
  late final TextEditingController nameController;
  late final TextEditingController descController;

  @override
  void initState() {
    super.initState();
    nameController = TextEditingController(text: widget.project?.name ?? '');
    descController = TextEditingController(text: widget.project?.description ?? '');
  }

  @override
  void dispose() {
    nameController.dispose();
    descController.dispose();
    super.dispose();
  }

  void save() {
    final name = nameController.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('請輸入專案名稱')),
      );
      return;
    }

    final proj = ProjectProfile(
      id: widget.project?.id ?? DateTime.now().millisecondsSinceEpoch.toString(),
      name: name,
      description: descController.text.trim(),
      createdAt: widget.project?.createdAt ?? DateTime.now().toIso8601String(),
      codebaseStates: widget.project?.codebaseStates ?? const {},
      transferHistory: widget.project?.transferHistory ?? [],
    );

    Navigator.of(context).pop(proj);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.project == null ? '新增專案' : '編輯專案'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: InputDecoration(labelText: '專案名稱', hintText: '例如: sst_dashboard_win'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: descController,
              maxLines: 3,
              decoration: InputDecoration(labelText: '專案描述', hintText: '選填'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: save,
          child: const Text('儲存'),
        ),
      ],
    );
  }
}

class ProjectDetailsDialog extends StatelessWidget {
  final ProjectProfile project;
  final List<ConnectionProfile> connections;

  const ProjectDetailsDialog({
    super.key,
    required this.project,
    required this.connections,
  });

  String _getConnectionName(String id) {
    final conn = connections.firstWhere(
      (e) => e.id == id,
      orElse: () => ConnectionProfile(
        id: '',
        name: '已刪除的連線',
        host: id,
        port: 22,
        username: '',
        password: '',
        autoLogin: false,
      ),
    );
    return conn.name.isEmpty ? conn.host : conn.name;
  }

  @override
  Widget build(BuildContext context) {
    final states = project.codebaseStates.values.toList();
    final history = project.transferHistory;

    return AlertDialog(
      title: Row(
        children: [
          Icon(Icons.hub_rounded, color: AppPalette.accent, size: 24),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              project.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: 480,
        height: 400,
        child: DefaultTabController(
          length: 2,
          child: Column(
            children: [
              const TabBar(
                tabs: [
                  Tab(text: 'Codebase 狀態'),
                  Tab(text: '搬遷歷史記錄'),
                ],
              ),
              const SizedBox(height: 12),
              Expanded(
                child: TabBarView(
                  children: [
                    // Codebase States List
                    states.isEmpty
                        ? Center(
                            child: Text(
                              '此專案尚未登記在任何連線機器上',
                              style: TextStyle(color: AppPalette.textMuted),
                            ),
                          )
                        : ListView.builder(
                            itemCount: states.length,
                            itemBuilder: (context, index) {
                              final state = states[index];
                              final connName = _getConnectionName(state.connectionId);
                              return Card(
                                color: AppPalette.surfaceElevated,
                                margin: const EdgeInsets.symmetric(vertical: 6),
                                child: Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          Icon(Icons.dns, size: 16, color: AppPalette.textSecondary),
                                          const SizedBox(width: 6),
                                          Expanded(
                                            child: Text(
                                              connName,
                                              style: TextStyle(fontWeight: FontWeight.bold),
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 8),
                                      _buildInfoRow('遠端路徑', state.remotePath),
                                      _buildInfoRow('最後開啟', _formatDate(state.lastActiveAt)),
                                      _buildInfoRow('最後同步', _formatDate(state.lastSyncAt)),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),
                    // Transfer History Timeline
                    history.isEmpty
                        ? Center(
                            child: Text(
                              '無搬遷歷史記錄',
                              style: TextStyle(color: AppPalette.textMuted),
                            ),
                          )
                        : ListView.builder(
                            itemCount: history.length,
                            itemBuilder: (context, index) {
                              final record = history[index];
                              final fromName = record.fromConnectionId == null
                                  ? 'Local PC'
                                  : _getConnectionName(record.fromConnectionId!);
                              final toName = _getConnectionName(record.toConnectionId);
                              return Padding(
                                padding: const EdgeInsets.symmetric(vertical: 8),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Column(
                                      children: [
                                        Icon(Icons.circle, size: 12, color: AppPalette.accent),
                                        if (index < history.length - 1)
                                          Container(width: 2, height: 40, color: AppPalette.border),
                                      ],
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            '從 $fromName 搬至 $toName',
                                            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            '來源路徑: ${record.fromPath}\n目標路徑: ${record.toPath}',
                                            style: TextStyle(fontSize: 11, color: AppPalette.textSecondary),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            _formatDate(record.timestamp),
                                            style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('關閉'),
        ),
      ],
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Text('$label: ', style: TextStyle(fontSize: 11, color: AppPalette.textMuted)),
          Expanded(
            child: Text(value.isEmpty ? '-' : value, style: TextStyle(fontSize: 11)),
          ),
        ],
      ),
    );
  }

  String _formatDate(String isoStr) {
    if (isoStr.isEmpty) return '-';
    try {
      final dt = DateTime.parse(isoStr);
      return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return isoStr;
    }
  }
}

