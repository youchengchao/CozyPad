part of cozypad;

/* =========================================================
   Login Page
========================================================= */

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final hostController = TextEditingController();
  final portController = TextEditingController(text: '22');
  final usernameController = TextEditingController();
  final passwordController = TextEditingController();

  bool remember = true;
  bool autoLogin = false;

  @override
  void initState() {
    super.initState();

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final provider = context.read<SSHProvider>();
      await provider.loadProfiles();

      final autoProfile = provider.autoLoginProfile;
      if (!mounted) return;

      if (autoProfile != null) {
        await provider.connectWithProfile(autoProfile);
      }
    });
  }

  @override
  void dispose() {
    hostController.dispose();
    portController.dispose();
    usernameController.dispose();
    passwordController.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    final host = hostController.text.trim();
    final port = int.tryParse(portController.text.trim()) ?? 22;
    final username = usernameController.text.trim();
    final password = passwordController.text;

    if (host.isEmpty || username.isEmpty || password.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('請輸入 Host、Username、Password')),
      );
      return;
    }

    await context.read<SSHProvider>().connect(
          host: host,
          port: port,
          username: username,
          password: password,
          remember: remember,
          autoLogin: autoLogin,
        );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<SSHProvider>();

    return Scaffold(
      body: AppBackdrop(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 980),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _GlassPanel(
                    padding: const EdgeInsets.all(28),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              height: 52,
                              width: 52,
                              decoration: BoxDecoration(
                                color: AppPalette.surfaceSoft,
                                borderRadius: BorderRadius.circular(14),
                                border: Border.all(color: AppPalette.borderStrong),
                              ),
                              child: Icon(Icons.dns_rounded, color: AppPalette.textPrimary, size: 28),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Agent operations for remote machines',
                                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                                          fontWeight: FontWeight.w800,
                                          letterSpacing: -0.5,
                                        ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    'SSH telemetry, GPU context, files, commands, and Hermes agent sessions in one desktop console.',
                                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                                          color: AppPalette.textMuted,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 22),
                        Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: AppPalette.surfaceElevated,
                            borderRadius: BorderRadius.circular(18),
                            border: Border.all(color: AppPalette.border),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Icon(Icons.link_rounded, color: AppPalette.textSecondary, size: 18),
                                  const SizedBox(width: 8),
                                  Text(
                                    'Saved connections',
                                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                          fontWeight: FontWeight.w800,
                                        ),
                                  ),
                                  const Spacer(),
                                  FilledButton.icon(
                                    onPressed: () async {
                                      final result = await showDialog<ConnectionProfile>(
                                        context: context,
                                        builder: (_) => const ProfileEditorDialog(),
                                      );
                                      if (result != null) {
                                        await provider.upsertProfile(result);
                                      }
                                    },
                                    icon: const Icon(Icons.add, size: 18),
                                    label: const Text('新增連線'),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 14),
                              if (provider.profiles.isEmpty)
                                Container(
                                  width: double.infinity,
                                  padding: const EdgeInsets.all(16),
                                  decoration: BoxDecoration(
                                    color: AppPalette.surface,
                                    borderRadius: BorderRadius.circular(16),
                                    border: Border.all(color: AppPalette.border),
                                  ),
                                  child: Text(
                                    '目前沒有已儲存連線',
                                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: AppPalette.textMuted),
                                  ),
                                )
                              else
                                GridView.builder(
                                  shrinkWrap: true,
                                  physics: const NeverScrollableScrollPhysics(),
                                  itemCount: provider.profiles.length,
                                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                                    crossAxisCount: 2,
                                    mainAxisSpacing: 12,
                                    crossAxisSpacing: 12,
                                    childAspectRatio: 2.9,
                                  ),
                                  itemBuilder: (context, index) {
                                    final profile = provider.profiles[index];
                                    return _ConnectionProfileCard(
                                      profile: profile,
                                      connecting: provider.isConnecting,
                                      onTap: () => provider.connectWithProfile(profile),
                                      onEdit: () async {
                                        final result = await showDialog<dynamic>(
                                          context: context,
                                          builder: (_) => ProfileEditorDialog(
                                            profile: profile,
                                          ),
                                        );
                                        if (result == 'delete') {
                                          await provider.deleteProfile(profile.id);
                                        } else if (result is ConnectionProfile) {
                                          await provider.upsertProfile(result);
                                        }
                                      },
                                      onDelete: () async {
                                        await provider.deleteProfile(profile.id);
                                      },
                                    );
                                  },
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (provider.errorMessage != null) ...[
                    const SizedBox(height: 12),
                    ErrorCard(message: provider.errorMessage!),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

