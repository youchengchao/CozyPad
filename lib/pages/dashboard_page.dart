part of cozypad;

/* =========================================================
   Dashboard Page (Redesigned as unified Project Hub Workspace)
   ========================================================= */

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage>
    with SingleTickerProviderStateMixin {
  int? _activeExtensionIndex; // null: none, 0: Monitor, 1: Files, 2: Terminal
  final GlobalKey _hermesKey = GlobalKey(debugLabel: 'hermes_agent_key');

  @override
  void initState() {
    super.initState();
    // Load profiles if not loaded
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<SSHProvider>().loadProfiles();
    });
  }

  final _codebasePathController = TextEditingController(text: '~');
  final _transferTargetPathController = TextEditingController(text: '~');
  String? _selectedSourceConnectionId;

  @override
  void dispose() {
    _codebasePathController.dispose();
    _transferTargetPathController.dispose();
    super.dispose();
  }

  void _createNewProject(SSHProvider provider) async {
    final result = await showDialog<ProjectProfile>(
      context: context,
      builder: (_) => const ProjectEditorDialog(),
    );
    if (result != null) {
      await provider.upsertProject(result);
      provider.selectProject(result);
    }
  }

  void _editProject(SSHProvider provider, ProjectProfile project) async {
    final result = await showDialog<ProjectProfile>(
      context: context,
      builder: (_) => ProjectEditorDialog(project: project),
    );
    if (result != null) {
      await provider.upsertProject(result);
      if (provider.activeProject?.id == project.id) {
        provider.selectProject(result);
      }
    }
  }

  void _createNewConnection(SSHProvider provider) async {
    final result = await showDialog<ConnectionProfile>(
      context: context,
      builder: (_) => const ProfileEditorDialog(),
    );
    if (result != null) {
      await provider.upsertProfile(result);
    }
  }

  void _editConnection(SSHProvider provider, ConnectionProfile profile) async {
    final result = await showDialog<ConnectionProfile>(
      context: context,
      builder: (_) => ProfileEditorDialog(profile: profile),
    );
    if (result != null) {
      await provider.upsertProfile(result);
      if (provider.activeConnection?.id == profile.id) {
        provider.selectConnection(result);
      }
    }
  }

  void _closeDrawerIfMobile() {
    if (MediaQuery.of(context).size.width < 760) {
      Navigator.of(context).maybePop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<SSHProvider>();

    return LayoutBuilder(
      builder: (context, constraints) {
        final isMobile = constraints.maxWidth < 760;

        if (isMobile) {
          return Scaffold(
            appBar: AppBar(
              title: const Text('CozyPad', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
              backgroundColor: AppPalette.backgroundDeep,
              leading: Builder(
                builder: (context) => IconButton(
                  icon: const Icon(Icons.menu, size: 20),
                  onPressed: () => Scaffold.of(context).openDrawer(),
                ),
              ),
              actions: [
                IconButton(
                  icon: const Icon(Icons.settings, size: 18),
                  onPressed: () {
                    showDialog(
                      context: context,
                      builder: (context) => const _SettingsDialog(),
                    );
                  },
                ),
              ],
            ),
            drawer: Drawer(
              width: 322,
              backgroundColor: AppPalette.background,
              child: Row(
                children: [
                  _buildLeftNav(provider),
                  Expanded(
                    child: Container(
                      decoration: BoxDecoration(
                        border: Border(left: BorderSide(color: AppPalette.border)),
                      ),
                      child: _buildMiddleSidebar(provider),
                    ),
                  ),
                ],
              ),
            ),
            body: _buildMainWorkspace(provider),
          );
        } else {
          return Scaffold(
            body: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 1. LEFT-MOST NAV BAR (width: 72)
                _buildLeftNav(provider),

                // 2. MIDDLE CONTEXT SIDEBAR (width: 250)
                _buildMiddleSidebar(provider),

                // 3. MAIN WORKSPACE AREA
                Expanded(
                  child: _buildMainWorkspace(provider),
                ),
              ],
            ),
          );
        }
      },
    );
  }

  Widget _buildMainWorkspace(SSHProvider provider) {
    final activeProject = provider.activeProject;
    
    if (activeProject != null) {
      return _buildWorkspaceGrid(provider, activeProject);
    } else {
      if (_activeExtensionIndex == null) {
        return _buildWelcomeScreen(provider);
      } else {
        return _buildFullScreenExtension(provider);
      }
    }
  }

  Widget _buildFullScreenExtension(SSHProvider provider) {
    final titles = ['System Monitor', 'Files Browser', 'SSH Terminal'];
    final icons = [Icons.monitor_heart, Icons.folder, Icons.terminal];

    if (_activeExtensionIndex == null) return const SizedBox.shrink();

    final title = titles[_activeExtensionIndex!];
    final icon = icons[_activeExtensionIndex!];

    final extensionPanels = [
      const MonitorTab(),
      const FilesTab(),
      CommandsTab(isActive: _activeExtensionIndex == 2),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Header
        Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          color: AppPalette.surfaceSoft,
          child: Row(
            children: [
              Icon(icon, size: 16, color: AppPalette.accent),
              const SizedBox(width: 10),
              Text(
                title,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                  color: AppPalette.textPrimary,
                ),
              ),
              const SizedBox(width: 32),
              // Inner tab switchers inside the header
              for (int i = 0; i < 3; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: TextButton.icon(
                    style: TextButton.styleFrom(
                      foregroundColor: _activeExtensionIndex == i ? AppPalette.textPrimary : AppPalette.textMuted,
                      backgroundColor: _activeExtensionIndex == i ? AppPalette.surface : Colors.transparent,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                        side: BorderSide(
                          color: _activeExtensionIndex == i ? AppPalette.borderStrong : Colors.transparent,
                        ),
                      ),
                    ),
                    icon: Icon(icons[i], size: 13),
                    label: Text(
                      i == 0 ? 'Monitor' : (i == 1 ? 'Files' : 'Terminal'),
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                    onPressed: () {
                      setState(() {
                        _activeExtensionIndex = i;
                      });
                    },
                  ),
                ),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.settings, size: 16),
                color: AppPalette.textMuted,
                tooltip: 'Settings / 設定',
                onPressed: () {
                  showDialog(
                    context: context,
                    builder: (context) => const _SettingsDialog(),
                  );
                },
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: const Icon(Icons.close, size: 16),
                color: AppPalette.textMuted,
                tooltip: 'Close Window',
                onPressed: () {
                  setState(() {
                    _activeExtensionIndex = null;
                  });
                },
              ),
            ],
          ),
        ),
        // Divider
        Container(height: 1, color: AppPalette.border),
        // Body
        Expanded(
          child: AppBackdrop(
            child: IndexedStack(
              index: _activeExtensionIndex,
              children: [
                for (int i = 0; i < extensionPanels.length; i++)
                  ExcludeFocus(
                    excluding: _activeExtensionIndex != i,
                    child: extensionPanels[i],
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildLeftNav(SSHProvider provider) {
    return Container(
      width: 72,
      decoration: BoxDecoration(
        color: AppPalette.backgroundDeep,
        border: Border(
          right: BorderSide(color: AppPalette.border),
        ),
      ),
      child: Column(
        children: [
          const SizedBox(height: 24),
          // Logo / Brand
          Container(
            height: 42,
            width: 42,
            decoration: BoxDecoration(
              color: AppPalette.surfaceSoft,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppPalette.borderStrong),
              boxShadow: [
                BoxShadow(
                  color: AppPalette.accent.withValues(alpha: 0.15),
                  blurRadius: 10,
                  spreadRadius: 2,
                )
              ],
            ),
            child: Icon(
              Icons.bolt_rounded,
              color: AppPalette.accent,
              size: 24,
            ),
          ),
          const SizedBox(height: 32),
          // Navigation Indicators / shortcuts
          _buildNavIconButton(
            icon: Icons.hub_rounded,
            tooltip: 'Hermes Agent Workspace',
            isSelected: provider.activeProject != null && _activeExtensionIndex == null,
            onPressed: provider.activeProject == null ? null : () {
              setState(() {
                _activeExtensionIndex = null;
              });
              _closeDrawerIfMobile();
            },
          ),
          const SizedBox(height: 12),
          Divider(height: 1, color: AppPalette.border, indent: 16, endIndent: 16),
          const SizedBox(height: 12),
          // Extension buttons (only require SSH connection, not active project)
          _buildNavIconButton(
            icon: Icons.monitor_heart,
            tooltip: 'System Monitor',
            isSelected: _activeExtensionIndex == 0,
            onPressed: !provider.isConnected ? null : () {
              setState(() {
                _activeExtensionIndex = _activeExtensionIndex == 0 ? null : 0;
              });
              _closeDrawerIfMobile();
            },
          ),
          _buildNavIconButton(
            icon: Icons.folder,
            tooltip: 'Files Browser',
            isSelected: _activeExtensionIndex == 1,
            onPressed: !provider.isConnected ? null : () {
              setState(() {
                _activeExtensionIndex = _activeExtensionIndex == 1 ? null : 1;
              });
              _closeDrawerIfMobile();
            },
          ),
          _buildNavIconButton(
            icon: Icons.terminal,
            tooltip: 'SSH Terminal',
            isSelected: _activeExtensionIndex == 2,
            onPressed: !provider.isConnected ? null : () {
              setState(() {
                _activeExtensionIndex = _activeExtensionIndex == 2 ? null : 2;
              });
              _closeDrawerIfMobile();
            },
          ),
          const Spacer(),
          // Connection Status indicator button
          if (provider.isConnected)
            _buildNavIconButton(
              icon: Icons.logout_rounded,
              tooltip: 'Disconnect SSH Connection',
              color: AppPalette.danger,
              onPressed: () {
                provider.disconnect();
                _closeDrawerIfMobile();
              },
            ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  Widget _buildNavIconButton({
    required IconData icon,
    required String tooltip,
    bool isSelected = false,
    Color? color,
    VoidCallback? onPressed,
  }) {
    return Tooltip(
      message: tooltip,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        height: 48,
        width: 48,
        decoration: BoxDecoration(
          color: isSelected ? AppPalette.surfaceSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isSelected ? AppPalette.borderStrong : Colors.transparent,
          ),
        ),
        child: IconButton(
          icon: Icon(icon, color: color ?? (isSelected ? AppPalette.textPrimary : AppPalette.textMuted)),
          onPressed: onPressed,
        ),
      ),
    );
  }

  Widget _buildMiddleSidebar(SSHProvider provider) {
    return Container(
      width: 250,
      decoration: BoxDecoration(
        color: AppPalette.background,
        border: Border(
          right: BorderSide(color: AppPalette.border),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Sidebar Header
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 24, 12, 16),
            child: Row(
              children: [
                Text(
                  'PROJECTS',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: AppPalette.textMuted,
                    letterSpacing: 1.0,
                  ),
                ),
                const Spacer(),
                IconButton(
                  tooltip: 'Create New Project',
                  icon: Icon(Icons.add, size: 18, color: AppPalette.textSecondary),
                  onPressed: () => _createNewProject(provider),
                ),
              ],
            ),
          ),

          // Scrollable Project List
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              itemCount: provider.projects.length,
              itemBuilder: (context, index) {
                final project = provider.projects[index];
                final isSelected = provider.activeProject?.id == project.id;
                final isCurrentHostActive = provider.isConnected &&
                    project.codebaseStates.containsKey(provider.activeConnection?.id);

                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Container(
                    decoration: BoxDecoration(
                      color: isSelected ? AppPalette.surface : Colors.transparent,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: isSelected ? AppPalette.border : Colors.transparent,
                      ),
                    ),
                    child: ListTile(
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                      title: Text(
                        project.name,
                        style: TextStyle(
                          fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
                          color: isSelected ? AppPalette.textPrimary : AppPalette.textSecondary,
                        ),
                      ),
                      subtitle: Text(
                        project.description.isEmpty ? 'Logical Project' : project.description,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                      ),
                      leading: _buildProjectStatusDot(isCurrentHostActive, isSelected),
                      trailing: isSelected
                          ? Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                IconButton(
                                  icon: Icon(Icons.info_outline, size: 14, color: AppPalette.textMuted),
                                  onPressed: () {
                                    showDialog(
                                      context: context,
                                      builder: (_) => ProjectDetailsDialog(
                                        project: project,
                                        connections: provider.connections,
                                      ),
                                    );
                                  },
                                ),
                                IconButton(
                                  icon: Icon(Icons.settings, size: 14, color: AppPalette.textMuted),
                                  onPressed: () => _editProject(provider, project),
                                ),
                              ],
                            )
                          : null,
                      onTap: () {
                        provider.selectProject(project);
                        _closeDrawerIfMobile();
                      },
                    ),
                  ),
                );
              },
            ),
          ),

          // Active Connection Status Card at bottom
          _buildActiveConnectionStatusCard(provider),
        ],
      ),
    );
  }

  Widget _buildProjectStatusDot(bool isConnected, bool isSelected) {
    Color dotColor = AppPalette.textMuted;
    if (isConnected) {
      dotColor = AppPalette.success;
    } else if (isSelected) {
      dotColor = AppPalette.accent;
    }

    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: dotColor,
        shape: BoxShape.circle,
        boxShadow: isConnected
            ? [
                BoxShadow(
                  color: AppPalette.success.withValues(alpha: 0.4),
                  blurRadius: 4,
                  spreadRadius: 1,
                )
              ]
            : null,
      ),
    );
  }

  Widget _buildActiveConnectionStatusCard(SSHProvider provider) {
    final activeConn = provider.activeConnection;
    final isConnected = provider.isConnected && activeConn != null;

    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'ACTIVE CONNECTION',
            style: TextStyle(
              fontSize: 9,
              fontWeight: FontWeight.w900,
              color: AppPalette.textMuted,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 6),
          if (isConnected) ...[
            Text(
              activeConn.name.isEmpty ? activeConn.host : activeConn.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
            ),
            Text(
              '${activeConn.username}@${activeConn.host}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10, color: AppPalette.textSecondary),
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              style: FilledButton.styleFrom(
                backgroundColor: AppPalette.danger.withValues(alpha: 0.1),
                foregroundColor: AppPalette.danger,
                padding: const EdgeInsets.symmetric(vertical: 8),
              ),
              onPressed: () => provider.disconnect(),
              child: const Text('Disconnect SSH', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
            ),
          ] else ...[
            Text(
              'No active host connection',
              style: TextStyle(fontSize: 12, color: AppPalette.textMuted, fontStyle: FontStyle.italic),
            ),
            const SizedBox(height: 12),
            if (provider.isConnecting)
              const SizedBox(
                height: 32,
                child: Center(
                  child: SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else if (provider.connections.isNotEmpty)
              DropdownButtonHideUnderline(
                child: DropdownButtonFormField<ConnectionProfile>(
                  decoration: const InputDecoration(
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    border: OutlineInputBorder(),
                    labelText: 'Quick Connect',
                  ),
                  style: TextStyle(fontSize: 12, color: AppPalette.textPrimary),
                  items: provider.connections.map((c) {
                    return DropdownMenuItem<ConnectionProfile>(
                      value: c,
                      child: Text(c.name.isEmpty ? c.host : c.name),
                    );
                  }).toList(),
                  onChanged: (c) {
                    if (c != null) {
                      provider.connectWithProfile(c);
                    }
                  },
                ),
              )
            else
              FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: AppPalette.surfaceSoft,
                  foregroundColor: AppPalette.textSecondary,
                  padding: const EdgeInsets.symmetric(vertical: 8),
                ),
                onPressed: () => _createNewConnection(provider),
                child: const Text('Add Connection', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
              ),
          ],
        ],
      ),
    );
  }

  Widget _buildWelcomeScreen(SSHProvider provider) {
    final isMobile = MediaQuery.of(context).size.width < 760;

    final projectsWidget = Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Icon(Icons.hub_rounded, color: AppPalette.accent),
                  const SizedBox(width: 8),
                  Text(
                    '開發專案 (${provider.projects.length})',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                  ),
                ],
              ),
              IconButton(
                icon: Icon(Icons.add, color: AppPalette.accent),
                tooltip: '建立新專案',
                onPressed: () => _createNewProject(provider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (provider.projects.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('目前無專案。請點擊右上角新增。', style: TextStyle(color: AppPalette.textMuted, fontSize: 13)),
              ),
            )
          else
            ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: provider.projects.length.clamp(0, 5),
              itemBuilder: (context, idx) {
                final proj = provider.projects[idx];
                return Card(
                  color: AppPalette.surfaceElevated,
                  margin: const EdgeInsets.symmetric(vertical: 6),
                  child: ListTile(
                    dense: true,
                    title: Text(proj.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                    subtitle: Text(
                      proj.description.isEmpty
                          ? '已登記在 ${proj.codebaseStates.length} 台機器'
                          : proj.description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11),
                    ),
                    trailing: const Icon(Icons.chevron_right, size: 16),
                    onTap: () {
                      provider.selectProject(proj);
                    },
                  ),
                );
              },
            ),
        ],
      ),
    );

    final connectionsWidget = Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppPalette.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Icon(Icons.dns_rounded, color: AppPalette.primary),
                  const SizedBox(width: 8),
                  Text(
                    '遠端連線 (${provider.connections.length})',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                  ),
                ],
              ),
              IconButton(
                icon: Icon(Icons.add, color: AppPalette.primary),
                tooltip: '建立新連線',
                onPressed: () => _createNewConnection(provider),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (provider.connections.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text('目前無連線。請點擊右上角新增。', style: TextStyle(color: AppPalette.textMuted, fontSize: 13)),
              ),
            )
          else
            ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: provider.connections.length.clamp(0, 5),
              itemBuilder: (context, idx) {
                final conn = provider.connections[idx];
                return Card(
                  color: AppPalette.surfaceElevated,
                  margin: const EdgeInsets.symmetric(vertical: 6),
                  child: ListTile(
                    dense: true,
                    title: Text(conn.name.isEmpty ? conn.host : conn.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                    subtitle: Text('${conn.username}@${conn.host}', style: const TextStyle(fontSize: 11)),
                    trailing: provider.isConnected && provider.connectedHost == conn.host
                        ? Icon(Icons.bolt, color: AppPalette.success, size: 16)
                        : const Icon(Icons.link, size: 16),
                    onTap: () async {
                      await provider.connectWithProfile(conn);
                    },
                  ),
                );
              },
            ),
        ],
      ),
    );

    return AppBackdrop(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(40),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 960),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ShaderMask(
                  shaderCallback: (bounds) => LinearGradient(
                    colors: [AppPalette.primary, AppPalette.accent],
                  ).createShader(bounds),
                  child: Text(
                    'Hermes Workspace Hub',
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.w900,
                          letterSpacing: -1.0,
                          color: Colors.white,
                        ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'A project-centric agentic control plane. Select a project from the sidebar to activate the Hermes Agent. Your memories and knowledge bases travel with your projects, decoupled from physical hosts.',
                  style: TextStyle(fontSize: 15, color: AppPalette.textSecondary, height: 1.5),
                ),
                const SizedBox(height: 36),
                if (isMobile)
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      projectsWidget,
                      const SizedBox(height: 24),
                      connectionsWidget,
                    ],
                  )
                else
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: projectsWidget),
                      const SizedBox(width: 24),
                      Expanded(child: connectionsWidget),
                    ],
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConnectionRequiredScreen(SSHProvider provider, ProjectProfile activeProject) {
    return AppBackdrop(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(40),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 800),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ShaderMask(
                  shaderCallback: (bounds) => LinearGradient(
                    colors: [AppPalette.primary, AppPalette.accent],
                  ).createShader(bounds),
                  child: Text(
                    '需要建立 SSH 連線',
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                          fontWeight: FontWeight.w900,
                          letterSpacing: -1.0,
                          color: Colors.white,
                        ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  '您目前選取了專案「${activeProject.name}」，請在下方選擇或新增一個連線，以開啟遠端開發工作區。',
                  style: TextStyle(fontSize: 16, color: AppPalette.textSecondary, height: 1.5),
                ),
                const SizedBox(height: 32),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '已儲存的遠端連線',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
                    ),
                    FilledButton.icon(
                      onPressed: () => _createNewConnection(provider),
                      icon: const Icon(Icons.add, size: 16),
                      label: const Text('新增連線', style: TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (provider.connections.isEmpty)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      color: AppPalette.surface,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppPalette.border),
                    ),
                    child: Center(
                      child: Text('目前沒有已儲存的連線，請點選右上角新增連線。', style: TextStyle(color: AppPalette.textMuted)),
                    ),
                  )
                else
                  GridView.builder(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: provider.connections.length,
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 2,
                      mainAxisSpacing: 16,
                      crossAxisSpacing: 16,
                      childAspectRatio: 2.8,
                    ),
                    itemBuilder: (context, index) {
                      final conn = provider.connections[index];
                      return Container(
                        decoration: BoxDecoration(
                          color: AppPalette.surface,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: AppPalette.border),
                        ),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(16),
                          onTap: () async {
                            await provider.connectWithProfile(conn);
                          },
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Row(
                              children: [
                                Container(
                                  height: 40,
                                  width: 40,
                                  decoration: BoxDecoration(
                                    color: AppPalette.surfaceSoft,
                                    borderRadius: BorderRadius.circular(10),
                                    border: Border.all(color: AppPalette.borderStrong),
                                  ),
                                  child: Icon(Icons.dns, color: AppPalette.textSecondary, size: 20),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Text(
                                        conn.name.isEmpty ? conn.host : conn.name,
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        '${conn.username}@${conn.host}',
                                        style: TextStyle(fontSize: 11, color: AppPalette.textMuted),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                IconButton(
                                  icon: Icon(Icons.edit, size: 14, color: AppPalette.textMuted),
                                  onPressed: () => _editConnection(provider, conn),
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildCodebaseSetupScreen(
    SSHProvider provider,
    ProjectProfile activeProject,
    ConnectionProfile activeConnection,
  ) {
    final otherStates = activeProject.codebaseStates.entries
        .where((e) => e.key != activeConnection.id)
        .toList();

    return AppBackdrop(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(40),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 800),
            child: DefaultTabController(
              length: otherStates.isNotEmpty ? 2 : 1,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ShaderMask(
                    shaderCallback: (bounds) => LinearGradient(
                      colors: [AppPalette.primary, AppPalette.accent],
                    ).createShader(bounds),
                    child: Text(
                      '設定 Codebase 路徑',
                      style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                            fontWeight: FontWeight.w900,
                            letterSpacing: -1.0,
                            color: Colors.white,
                          ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '專案「${activeProject.name}」在目前連線的機器「${activeConnection.name}」上尚未登記 codebase 狀態。請在下方進行登記或進行 codebase 搬遷。',
                    style: TextStyle(fontSize: 14, color: AppPalette.textSecondary, height: 1.5),
                  ),
                  const SizedBox(height: 28),
                  TabBar(
                    isScrollable: true,
                    tabAlignment: TabAlignment.start,
                    tabs: [
                      const Tab(text: '登記現有 codebase 路徑'),
                      if (otherStates.isNotEmpty) const Tab(text: '從其他機器搬遷 codebase'),
                    ],
                  ),
                  const SizedBox(height: 20),
                  SizedBox(
                    height: 260,
                    child: TabBarView(
                      children: [
                        // Tab 1: Register path
                        _buildRegisterPathForm(provider, activeProject, activeConnection),
                        // Tab 2: Transfer path
                        if (otherStates.isNotEmpty)
                          _buildTransferPathForm(provider, activeProject, activeConnection, otherStates),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRegisterPathForm(
    SSHProvider provider,
    ProjectProfile activeProject,
    ConnectionProfile activeConnection,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '請輸入此專案在此機器上的遠端 codebase 目錄路徑。Hermes 專案專屬的記憶與知識庫會在此目錄啟動時進行雙向同步與載入。',
          style: TextStyle(fontSize: 13, color: AppPalette.textMuted, height: 1.4),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _codebasePathController,
          decoration: const InputDecoration(
            labelText: '遠端 Codebase 路徑',
            hintText: '/home/username/project_folder',
          ),
        ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: () async {
            final path = _codebasePathController.text.trim();
            if (path.isEmpty) return;
            await provider.updateProjectCodebaseState(
              activeProject.id,
              activeConnection.id,
              path,
            );
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('已成功登記專案 codebase 路徑: $path')),
            );
          },
          child: const Text('登記 codebase 路徑', style: TextStyle(fontWeight: FontWeight.bold)),
        ),
      ],
    );
  }

  Widget _buildTransferPathForm(
    SSHProvider provider,
    ProjectProfile activeProject,
    ConnectionProfile activeConnection,
    List<MapEntry<String, ProjectCodebaseState>> otherStates,
  ) {
    if (_selectedSourceConnectionId == null && otherStates.isNotEmpty) {
      _selectedSourceConnectionId = otherStates.first.key;
    }

    final selectedState = activeProject.codebaseStates[_selectedSourceConnectionId];
    final sourcePath = selectedState?.remotePath ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '您可以從其他登記過此專案的機器中，搬遷 codebase 到目前這台機器上。這會協助建立專案搬遷軌跡，並同步專案記憶與知識庫。',
          style: TextStyle(fontSize: 13, color: AppPalette.textMuted, height: 1.4),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _selectedSourceConnectionId,
                decoration: const InputDecoration(labelText: '來源機器'),
                items: otherStates.map((entry) {
                  final conn = provider.connections.firstWhere(
                    (c) => c.id == entry.key,
                    orElse: () => ConnectionProfile(
                      id: entry.key,
                      name: '未知連線',
                      host: entry.key,
                      port: 22,
                      username: '',
                      password: '',
                      autoLogin: false,
                    ),
                  );
                  return DropdownMenuItem<String>(
                    value: entry.key,
                    child: Text('${conn.name} (路徑: ${entry.value.remotePath})'),
                  );
                }).toList(),
                onChanged: (val) {
                  setState(() {
                    _selectedSourceConnectionId = val;
                  });
                },
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: TextField(
                controller: _transferTargetPathController,
                decoration: const InputDecoration(
                  labelText: '目標遠端 Codebase 路徑',
                  hintText: '例如: ~/projects/my-new-path',
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: () async {
            final targetPath = _transferTargetPathController.text.trim();
            if (targetPath.isEmpty || _selectedSourceConnectionId == null) return;

            // 登記搬遷記錄
            await provider.recordProjectTransfer(
              activeProject.id,
              fromConnectionId: _selectedSourceConnectionId,
              toConnectionId: activeConnection.id,
              fromPath: sourcePath,
              toPath: targetPath,
            );

            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('已登記專案搬遷並建立目標 codebase 路徑: $targetPath。您可透過 Hermes 進行進一步檔案同步。')),
            );
          },
          child: const Text('開始搬遷並登記', style: TextStyle(fontWeight: FontWeight.bold)),
        ),
      ],
    );
  }

  Widget _buildWorkspaceGrid(SSHProvider provider, ProjectProfile activeProject) {
    final activeConnection = provider.activeConnection;

    // 1. If connection not established, require connection
    if (!provider.isConnected || activeConnection == null) {
      return _buildConnectionRequiredScreen(provider, activeProject);
    }

    // 2. If codebase path not registered on this connection, require registration
    final codebaseState = activeProject.codebaseStates[activeConnection.id];
    if (codebaseState == null) {
      return _buildCodebaseSetupScreen(provider, activeProject, activeConnection);
    }

    return Stack(
      children: [
        // Main Core: Hermes Agent (always present, full-width)
        Positioned.fill(
          child: HermesNativeTab(key: _hermesKey),
        ),

        // Floating Banner for active codebase status
        Positioned(
          top: 8,
          right: 8,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: AppPalette.backgroundDeep.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: AppPalette.borderStrong),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.folder_shared, size: 14, color: AppPalette.accent),
                const SizedBox(width: 6),
                Text(
                  'Codebase: ${codebaseState.remotePath}',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                ),
                const SizedBox(width: 8),
                Container(width: 1, height: 12, color: AppPalette.border),
                const SizedBox(width: 8),
                InkWell(
                  onTap: () {
                    showDialog(
                      context: context,
                      builder: (_) => ProjectDetailsDialog(
                        project: activeProject,
                        connections: provider.connections,
                      ),
                    );
                  },
                  child: Text(
                    '狀態與搬遷歷史',
                    style: TextStyle(fontSize: 11, color: AppPalette.accent, fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            ),
          ),
        ),

        // Floating Popup Drawer Overlay
        if (_activeExtensionIndex != null)
          Positioned.fill(
            child: GestureDetector(
              onTap: () {
                setState(() {
                  _activeExtensionIndex = null;
                });
              },
              child: Container(
                color: Colors.black54, // Dim background backdrop
                child: GestureDetector(
                  onTap: () {
                    // Prevent backdrop tap from dismissing dialog
                  },
                  child: Center(
                    child: Container(
                      width: MediaQuery.of(context).size.width * 0.85,
                      height: MediaQuery.of(context).size.height * 0.85,
                      decoration: BoxDecoration(
                        color: AppPalette.backgroundDeep,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppPalette.border),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.6),
                            blurRadius: 24,
                            spreadRadius: 8,
                          ),
                        ],
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(11),
                        child: _buildPopupContent(),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildPopupContent() {
    final titles = ['System Monitor', 'Files Browser', 'SSH Terminal'];
    final icons = [Icons.monitor_heart, Icons.folder, Icons.terminal];

    if (_activeExtensionIndex == null) return const SizedBox.shrink();

    final title = titles[_activeExtensionIndex!];
    final icon = icons[_activeExtensionIndex!];

    final extensionPanels = [
      const MonitorTab(),
      const FilesTab(),
      CommandsTab(isActive: _activeExtensionIndex == 2),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Popup Header
        Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          color: AppPalette.surfaceSoft,
          child: Row(
            children: [
              Icon(icon, size: 16, color: AppPalette.accent),
              const SizedBox(width: 10),
              Text(
                title,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                  color: AppPalette.textPrimary,
                ),
              ),
              const SizedBox(width: 32),
              // Inner tab switchers inside the popup header
              for (int i = 0; i < 3; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: TextButton.icon(
                    style: TextButton.styleFrom(
                      foregroundColor: _activeExtensionIndex == i ? AppPalette.textPrimary : AppPalette.textMuted,
                      backgroundColor: _activeExtensionIndex == i ? AppPalette.surface : Colors.transparent,
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                        side: BorderSide(
                          color: _activeExtensionIndex == i ? AppPalette.borderStrong : Colors.transparent,
                        ),
                      ),
                    ),
                    icon: Icon(icons[i], size: 13),
                    label: Text(
                      i == 0 ? 'Monitor' : (i == 1 ? 'Files' : 'Terminal'),
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
                    ),
                    onPressed: () {
                      setState(() {
                        _activeExtensionIndex = i;
                      });
                    },
                  ),
                ),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.settings, size: 16),
                color: AppPalette.textMuted,
                tooltip: 'Settings / 設定',
                onPressed: () {
                  showDialog(
                    context: context,
                    builder: (context) => const _SettingsDialog(),
                  );
                },
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: const Icon(Icons.close, size: 16),
                color: AppPalette.textMuted,
                tooltip: 'Close Window',
                onPressed: () {
                  setState(() {
                    _activeExtensionIndex = null;
                  });
                },
              ),
            ],
          ),
        ),
        // Divider
        Container(height: 1, color: AppPalette.border),
        // Popup Body
        Expanded(
          child: AppBackdrop(
            child: IndexedStack(
              index: _activeExtensionIndex,
              children: [
                for (int i = 0; i < extensionPanels.length; i++)
                  ExcludeFocus(
                    excluding: _activeExtensionIndex != i,
                    child: extensionPanels[i],
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

