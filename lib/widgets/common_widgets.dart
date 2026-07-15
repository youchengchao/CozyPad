part of ssh_dashboard;


/* =========================================================
   App Visual System
========================================================= */

class AppPalette {
  // Linear-inspired dark developer UI: neutral graphite surfaces, low-contrast borders,
  // and restrained accent colors reserved for state and data emphasis.
  static const background = Color(0xFF08090A);
  static const backgroundDeep = Color(0xFF050506);
  static const surface = Color(0xFF101112);
  static const surfaceElevated = Color(0xFF151617);
  static const surfaceSoft = Color(0xFF1A1B1D);
  static const border = Color(0xFF242628);
  static const borderStrong = Color(0xFF303236);

  static const primary = Color(0xFFEDEDED);
  static const primarySoft = Color(0xFFA1A1AA);
  static const accent = Color(0xFF6E8CFF);
  static const accentSoft = Color(0xFF8B7CFF);
  static const success = Color(0xFF86EFAC);
  static const warning = Color(0xFFFACC15);
  static const danger = Color(0xFFFB7185);

  static const textPrimary = Color(0xFFF5F5F5);
  static const textSecondary = Color(0xFFA1A1AA);
  static const textMuted = Color(0xFF71717A);
}

class AppGradients {
  static const page = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      AppPalette.backgroundDeep,
      AppPalette.background,
      Color(0xFF0B0C0D),
    ],
  );

  static const surface = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      AppPalette.surfaceElevated,
      AppPalette.surface,
    ],
  );

  static const accent = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      Color(0xFF2A2C31),
      AppPalette.surfaceSoft,
    ],
  );

  static const gpu = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      AppPalette.surfaceSoft,
      AppPalette.surface,
    ],
  );
}

class AppBackdrop extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;

  const AppBackdrop({
    super.key,
    required this.child,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(gradient: AppGradients.page),
      child: Stack(
        children: [
          const Positioned(
            top: -180,
            right: -120,
            child: _AuroraOrb(size: 320, color: AppPalette.accentSoft),
          ),
          const Positioned(
            left: -160,
            bottom: -190,
            child: _AuroraOrb(size: 340, color: AppPalette.accent),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: padding ?? EdgeInsets.zero,
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}

class _AuroraOrb extends StatelessWidget {
  final double size;
  final Color color;

  const _AuroraOrb({
    required this.size,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              color.withOpacity(0.055),
              color.withOpacity(0.018),
              Colors.transparent,
            ],
          ),
        ),
      ),
    );
  }
}

/* =========================================================
   General UI Widgets
========================================================= */

class ResourceHeroCard extends StatelessWidget {
  final String host;
  final double cpuUsage;
  final double memoryUsage;
  final int gpuCount;
  final int activeGpuProcesses;
  final DateTime? lastUpdated;
  final bool isPolling;

  const ResourceHeroCard({
    super.key,
    required this.host,
    required this.cpuUsage,
    required this.memoryUsage,
    required this.gpuCount,
    required this.activeGpuProcesses,
    required this.lastUpdated,
    required this.isPolling,
  });

  String _timeLabel(DateTime? time) {
    if (time == null) return 'Waiting for first refresh';
    final hour = time.hour.toString().padLeft(2, '0');
    final minute = time.minute.toString().padLeft(2, '0');
    final second = time.second.toString().padLeft(2, '0');
    return 'Updated $hour:$minute:$second';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusText = isPolling ? 'Refreshing' : _timeLabel(lastUpdated);

    return _GlassPanel(
      padding: const EdgeInsets.all(18),
      child: Row(
        children: [
          Container(
            height: 58,
            width: 58,
            decoration: BoxDecoration(
              color: AppPalette.surfaceSoft,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppPalette.borderStrong),
            ),
            child: const Icon(Icons.dns_rounded, color: Colors.white, size: 30),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  host,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: -0.2,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Live SSH telemetry · CPU, memory, GPU and task context',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _MetricPill(icon: Icons.speed_rounded, label: 'CPU ${cpuUsage.toStringAsFixed(0)}%'),
                    _MetricPill(icon: Icons.storage_rounded, label: 'MEM ${memoryUsage.toStringAsFixed(0)}%'),
                    _MetricPill(icon: Icons.developer_board_rounded, label: '$gpuCount GPU${gpuCount == 1 ? '' : 's'}'),
                    _MetricPill(icon: Icons.play_circle_outline_rounded, label: '$activeGpuProcesses process${activeGpuProcesses == 1 ? '' : 'es'}'),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: AppPalette.surfaceSoft,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: AppPalette.border),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  isPolling ? Icons.sync_rounded : Icons.check_circle_outline_rounded,
                  size: 16,
                  color: isPolling ? AppPalette.accentSoft : AppPalette.success,
                ),
                const SizedBox(width: 6),
                Text(
                  statusText,
                  style: theme.textTheme.labelMedium?.copyWith(color: AppPalette.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class MetricCard extends StatelessWidget {
  final String title;
  final String subtitle;
  final String value;
  final double progress;
  final IconData icon;
  final bool compact;

  const MetricCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.progress,
    required this.icon,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final safeProgress = progress.clamp(0.0, 1.0).toDouble();

    return _GlassPanel(
      padding: EdgeInsets.all(compact ? 12 : 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Container(
                height: compact ? 32 : 40,
                width: compact ? 32 : 40,
                decoration: BoxDecoration(
                  color: AppPalette.surfaceSoft,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppPalette.borderStrong),
                ),
                child: Icon(icon, size: compact ? 18 : 22, color: AppPalette.accent),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      overflow: TextOverflow.ellipsis,
                      style: (compact ? theme.textTheme.titleSmall : theme.textTheme.titleMedium)?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      subtitle,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                value,
                style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
            ],
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(
              value: safeProgress,
              minHeight: 9,
              backgroundColor: AppPalette.border,
              valueColor: const AlwaysStoppedAnimation<Color>(AppPalette.accent),
            ),
          ),
        ],
      ),
    );
  }
}

class GpuCard extends StatelessWidget {
  final GpuMetric gpu;

  const GpuCard({
    super.key,
    required this.gpu,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final hasProcesses = gpu.processes.isNotEmpty;

    return _GlassPanel(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                height: 44,
                width: 44,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  gradient: AppGradients.gpu,
                  border: Border.all(color: AppPalette.accent.withOpacity(0.26)),
                ),
                child: const Icon(Icons.developer_board_rounded, color: Colors.white),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'GPU #${gpu.index}',
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      gpu.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                    ),
                  ],
                ),
              ),
              _GpuStatChip(
                icon: Icons.thermostat_rounded,
                label: '${gpu.temperature.toStringAsFixed(0)}°C',
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: _GpuMiniStat(
                  label: 'Utilization',
                  value: '${gpu.usage.toStringAsFixed(0)}%',
                  icon: Icons.speed_rounded,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _GpuMiniStat(
                  label: 'Processes',
                  value: '${gpu.processCount}',
                  icon: hasProcesses ? Icons.play_circle_outline_rounded : Icons.pause_circle_outline_rounded,
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          MetricBar(
            label: 'GPU Usage',
            value: '${gpu.usage.toStringAsFixed(1)}%',
            progress: gpu.usage / 100,
          ),
          const SizedBox(height: 12),
          MetricBar(
            label: 'VRAM',
            value:
                '${gpu.memoryUsedMb.toStringAsFixed(0)} / ${gpu.memoryTotalMb.toStringAsFixed(0)} MB',
            progress: gpu.memoryUsagePercent / 100,
          ),
          const SizedBox(height: 14),
          Expanded(
            child: _GpuProcessList(processes: gpu.processes),
          ),
        ],
      ),
    );
  }
}

class _GpuProcessList extends StatelessWidget {
  final List<GpuProcessMetric> processes;

  const _GpuProcessList({required this.processes});

  void _showCommandDialog(BuildContext context, GpuProcessMetric process) {
    final theme = Theme.of(context);
    final command = process.displayCommand.trim();
    final safeCommand = command.isEmpty ? process.shortName : command;

    showDialog<void>(
      context: context,
      builder: (dialogContext) {
        final dialogSize = MediaQuery.of(dialogContext).size;
        final dialogWidth = (dialogSize.width * 0.82).clamp(320.0, 720.0).toDouble();

        return AlertDialog(
          title: const Text('Process command'),
          content: SizedBox(
            width: dialogWidth,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${process.username} · PID ${process.pid} · runtime ${process.runtimeLabel} · ${process.usedMemoryMb.toStringAsFixed(0)} MB',
                  style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textSecondary),
                ),
                const SizedBox(height: 12),
                Container(
                  constraints: BoxConstraints(
                    maxHeight: dialogSize.height * 0.48,
                  ),
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.black26,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.white12),
                  ),
                  child: SingleChildScrollView(
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: SelectableText(
                        safeCommand,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: Colors.white70,
                          fontFamily: 'Consolas',
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: safeCommand));
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Command copied')),
                  );
                }
              },
              icon: const Icon(Icons.copy, size: 16),
              label: const Text('Copy'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Close'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (processes.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppPalette.backgroundDeep.withOpacity(0.36),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppPalette.surfaceSoft),
        ),
        child: Row(
          children: [
            const Icon(Icons.nightlight_round, size: 16, color: AppPalette.textMuted),
            const SizedBox(width: 8),
            Text(
              'No running compute processes',
              style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
            ),
          ],
        ),
      );
    }

    final visible = processes.take(4).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              'Processes',
              style: theme.textTheme.labelLarge?.copyWith(color: AppPalette.textSecondary),
            ),
            const Spacer(),
            Text(
              'runtime shown per PID',
              style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Expanded(
          child: ListView(
            physics: const NeverScrollableScrollPhysics(),
            padding: EdgeInsets.zero,
            children: [
              for (final process in visible)
                _GpuProcessRow(
                  process: process,
                  onTap: () => _showCommandDialog(context, process),
                ),
              if (processes.length > visible.length)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    '+${processes.length - visible.length} more',
                    style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _GpuProcessRow extends StatelessWidget {
  final GpuProcessMetric process;
  final VoidCallback onTap;

  const _GpuProcessRow({
    required this.process,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final command = process.displayCommand.trim();
    final hasDetailedCommand = command.isNotEmpty && command != process.shortName;

    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: hasDetailedCommand ? onTap : null,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: AppPalette.surfaceElevated,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppPalette.surfaceSoft),
            ),
            child: Row(
              children: [
                Icon(
                  hasDetailedCommand ? Icons.open_in_new_rounded : Icons.circle,
                  size: hasDetailedCommand ? 15 : 6,
                  color: AppPalette.accentSoft,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${process.username} · PID ${process.pid}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelMedium?.copyWith(color: AppPalette.textSecondary),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        process.shortName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      process.runtimeLabel,
                      style: theme.textTheme.labelMedium?.copyWith(color: AppPalette.accent),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${process.usedMemoryMb.toStringAsFixed(0)} MB',
                      style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class MetricBar extends StatelessWidget {
  final String label;
  final String value;
  final double progress;

  const MetricBar({
    super.key,
    required this.label,
    required this.value,
    required this.progress,
  });

  @override
  Widget build(BuildContext context) {
    final safeProgress = progress.clamp(0.0, 1.0).toDouble();
    final theme = Theme.of(context);

    return Column(
      children: [
        Row(
          children: [
            Text(label, style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted)),
            const Spacer(),
            Text(value, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700)),
          ],
        ),
        const SizedBox(height: 7),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: safeProgress,
            minHeight: 8,
            backgroundColor: AppPalette.border,
            valueColor: AlwaysStoppedAnimation<Color>(
              safeProgress > 0.82 ? AppPalette.warning : AppPalette.accent,
            ),
          ),
        ),
      ],
    );
  }
}

class _GlassPanel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;

  const _GlassPanel({
    required this.child,
    this.padding = const EdgeInsets.all(16),
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppPalette.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.20),
            blurRadius: 18,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Padding(
        padding: padding,
        child: child,
      ),
    );
  }
}

class _MetricPill extends StatelessWidget {
  final IconData icon;
  final String label;

  const _MetricPill({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppPalette.surfaceSoft,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppPalette.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: AppPalette.accent),
          const SizedBox(width: 6),
          Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: AppPalette.textSecondary)),
        ],
      ),
    );
  }
}

class _GpuStatChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _GpuStatChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppPalette.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: AppPalette.warning),
          const SizedBox(width: 5),
          Text(label, style: Theme.of(context).textTheme.labelMedium),
        ],
      ),
    );
  }
}

class _GpuMiniStat extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _GpuMiniStat({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppPalette.surfaceElevated,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppPalette.border),
      ),
      child: Row(
        children: [
          Icon(icon, size: 17, color: AppPalette.accentSoft),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted)),
                const SizedBox(height: 2),
                Text(value, style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class TaskCard extends StatelessWidget {
  final TaskItem task;

  const TaskCard({
    super.key,
    required this.task,
  });

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(task.status);

    return Card(
      color: AppPalette.surface,
      child: ListTile(
        leading: Icon(
          _statusIcon(task.status),
          color: color,
        ),
        title: Text(task.title),
        subtitle: task.detail.isEmpty ? null : Text(task.detail),
        trailing: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: color.withOpacity(0.4)),
          ),
          child: Text(
            task.status,
            style: TextStyle(color: color),
          ),
        ),
      ),
    );
  }

  Color _statusColor(String status) {
    final s = status.toLowerCase();

    if (s.contains('complete') || s.contains('done') || s.contains('success')) {
      return AppPalette.success;
    }

    if (s.contains('proceed') ||
        s.contains('running') ||
        s.contains('progress')) {
      return AppPalette.warning;
    }

    if (s.contains('pending') || s.contains('wait')) {
      return AppPalette.accentSoft;
    }

    if (s.contains('error') || s.contains('fail')) {
      return AppPalette.danger;
    }

    return AppPalette.textMuted;
  }

  IconData _statusIcon(String status) {
    final s = status.toLowerCase();

    if (s.contains('complete') || s.contains('done') || s.contains('success')) {
      return Icons.check_circle;
    }

    if (s.contains('proceed') ||
        s.contains('running') ||
        s.contains('progress')) {
      return Icons.sync;
    }

    if (s.contains('pending') || s.contains('wait')) {
      return Icons.schedule;
    }

    if (s.contains('error') || s.contains('fail')) {
      return Icons.error;
    }

    return Icons.help_outline;
  }
}

class ResponsiveGrid extends StatelessWidget {
  final int itemCount;
  final double minItemWidth;
  final double childAspectRatio;
  final Widget Function(BuildContext context, int index) itemBuilder;

  const ResponsiveGrid({
    super.key,
    required this.itemCount,
    required this.itemBuilder,
    this.minItemWidth = 180,
    this.childAspectRatio = 1.4,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final count = (constraints.maxWidth / minItemWidth).floor().clamp(1, 8).toInt();

        return GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: itemCount,
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: count,
            mainAxisSpacing: 12,
            crossAxisSpacing: 12,
            childAspectRatio: childAspectRatio,
          ),
          itemBuilder: itemBuilder,
        );
      },
    );
  }
}


class CollapsibleSectionHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final bool isExpanded;
  final VoidCallback onTap;

  const CollapsibleSectionHeader({
    super.key,
    required this.title,
    this.subtitle,
    required this.isExpanded,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: AppPalette.surface.withOpacity(0.68),
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: AppPalette.border),
          ),
          child: Row(
            children: [
              AnimatedRotation(
                turns: isExpanded ? 0.25 : 0,
                duration: const Duration(milliseconds: 160),
                child: const Icon(Icons.chevron_right_rounded),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                    ),
                    if (subtitle != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(color: AppPalette.textMuted),
                      ),
                    ],
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: AppPalette.surfaceSoft,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: AppPalette.border),
                ),
                child: Text(
                  isExpanded ? 'Collapse' : 'Expand',
                  style: theme.textTheme.labelMedium?.copyWith(color: AppPalette.textSecondary),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  final String text;

  const SectionTitle(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: Theme.of(context).textTheme.titleLarge,
    );
  }
}

class InfoCard extends StatelessWidget {
  final String text;

  const InfoCard({
    super.key,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppPalette.surface,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Text(text),
      ),
    );
  }
}

class ErrorCard extends StatelessWidget {
  final String message;

  const ErrorCard({
    super.key,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      color: AppPalette.danger.withOpacity(0.14),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Text(
          message,
          style: const TextStyle(color: AppPalette.danger),
        ),
      ),
    );
  }
}


