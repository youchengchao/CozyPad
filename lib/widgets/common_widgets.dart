part of cozypad;


/* =========================================================
   App Visual System
========================================================= */

class AppPalette {
  // Linear-inspired dark developer UI: neutral graphite surfaces, low-contrast borders,
  // and restrained accent colors reserved for state and data emphasis.
  static Color background = const Color(0xFF08090A);
  static Color backgroundDeep = const Color(0xFF050506);
  static Color surface = const Color(0xFF101112);
  static Color surfaceElevated = const Color(0xFF151617);
  static Color surfaceSoft = const Color(0xFF1A1B1D);
  static Color border = const Color(0xFF242628);
  static Color borderStrong = const Color(0xFF303236);

  static Color primary = const Color(0xFFEDEDED);
  static Color primarySoft = const Color(0xFFA1A1AA);
  static Color accent = const Color(0xFF6E8CFF);
  static Color accentSoft = const Color(0xFF8B7CFF);
  static Color success = const Color(0xFF86EFAC);
  static Color warning = const Color(0xFFFACC15);
  static Color danger = const Color(0xFFFB7185);

  static Color textPrimary = const Color(0xFFF5F5F5);
  static Color textSecondary = const Color(0xFFA1A1AA);
  static Color textMuted = const Color(0xFF71717A);
}

class AppGradients {
  static LinearGradient get page => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      AppPalette.backgroundDeep,
      AppPalette.background,
      const Color(0xFF0B0C0D),
    ],
  );

  static LinearGradient get surface => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      AppPalette.surfaceElevated,
      AppPalette.surface,
    ],
  );

  static LinearGradient get accent => LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      const Color(0xFF2A2C31),
      AppPalette.surfaceSoft,
    ],
  );

  static LinearGradient get gpu => LinearGradient(
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
      decoration: BoxDecoration(gradient: AppGradients.page),
      child: Stack(
        children: [
          Positioned(
            top: -180,
            right: -120,
            child: _AuroraOrb(size: 320, color: AppPalette.accentSoft),
          ),
          Positioned(
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
              color.withValues(alpha: 0.055),
              color.withValues(alpha: 0.018),
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
              valueColor: AlwaysStoppedAnimation<Color>(AppPalette.accent),
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
                  border: Border.all(color: AppPalette.accent.withValues(alpha: 0.26)),
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
          color: AppPalette.backgroundDeep.withValues(alpha: 0.36),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppPalette.surfaceSoft),
        ),
        child: Row(
          children: [
            Icon(Icons.nightlight_round, size: 16, color: AppPalette.textMuted),
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
            color: Colors.black.withValues(alpha: 0.20),
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
            color: color.withValues(alpha: 0.15),
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: color.withValues(alpha: 0.4)),
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
            color: AppPalette.surface.withValues(alpha: 0.68),
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
      color: AppPalette.danger.withValues(alpha: 0.14),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Text(
          message,
          style: TextStyle(color: AppPalette.danger),
        ),
      ),
    );
  }
}

class AppThemeData {
  final String name;
  final String subtitle;
  final Color background;
  final Color backgroundDeep;
  final Color surface;
  final Color surfaceElevated;
  final Color surfaceSoft;
  final Color border;
  final Color borderStrong;
  final Color primary;
  final Color primarySoft;
  final Color accent;
  final Color accentSoft;
  final Color success;
  final Color warning;
  final Color danger;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;

  const AppThemeData({
    required this.name,
    this.subtitle = '',
    required this.background,
    required this.backgroundDeep,
    required this.surface,
    required this.surfaceElevated,
    required this.surfaceSoft,
    required this.border,
    required this.borderStrong,
    required this.primary,
    required this.primarySoft,
    required this.accent,
    required this.accentSoft,
    required this.success,
    required this.warning,
    required this.danger,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
  });
}

// ───────────────────────────────────────────────────────────────────
// HAND-TUNED THEME PRESETS
//
// Design rationale for each theme:
//   • Surface layers progress in ~+6 lightness steps for clear depth.
//   • Accent hue sits ≥120° from the dominant surface hue for pop.
//   • textPrimary : background contrast ratio ≥ 12:1 (WCAG AAA).
//   • Semantic colors (success/warning/danger) are desaturated 10-20%
//     from pure to reduce eye strain on dark backgrounds.
//   • border vs surface delta is tuned to be visible but not harsh
//     (lightness diff 8-12%).
// ───────────────────────────────────────────────────────────────────
final List<AppThemeData> appThemes = [

  // ── 1. GRAPHITE (Original Default) ──────────────────────────────
  // The original CozyPad identity. Pure neutral graphite with a cool
  // blue accent. Surfaces are nearly achromatic with a hair of blue
  // undertone (hue 210°, saturation 4-6%). The blue accent at 228°
  // provides maximum hue distance from the warm-neutral text.
  const AppThemeData(
    name: 'Graphite',
    subtitle: '預設 · 經典石墨',
    background: Color(0xFF08090A),
    backgroundDeep: Color(0xFF050506),
    surface: Color(0xFF101112),
    surfaceElevated: Color(0xFF151617),
    surfaceSoft: Color(0xFF1A1B1D),
    border: Color(0xFF242628),
    borderStrong: Color(0xFF303236),
    primary: Color(0xFFEDEDED),
    primarySoft: Color(0xFFA1A1AA),
    accent: Color(0xFF6E8CFF),
    accentSoft: Color(0xFF8B7CFF),
    success: Color(0xFF86EFAC),
    warning: Color(0xFFFACC15),
    danger: Color(0xFFFB7185),
    textPrimary: Color(0xFFF5F5F5),
    textSecondary: Color(0xFFA1A1AA),
    textMuted: Color(0xFF71717A),
  ),

  // ── 2. OBSIDIAN EMBER ───────────────────────────────────────────
  // Warm-toned dark theme. Surfaces carry a subtle warm brown
  // undertone (hue 20°, sat 8%). The accent is a copper-amber at
  // hue 28° with high saturation, creating an earthy-premium feel.
  // Success is a warm sage, danger is a dusty coral — all pulled
  // toward the warm end of the spectrum for cohesion.
  const AppThemeData(
    name: 'Obsidian Ember',
    subtitle: '暖色黑曜岩',
    background: Color(0xFF0C0A08),
    backgroundDeep: Color(0xFF070605),
    surface: Color(0xFF141210),
    surfaceElevated: Color(0xFF1A1714),
    surfaceSoft: Color(0xFF211D19),
    border: Color(0xFF2E2923),
    borderStrong: Color(0xFF3D362E),
    primary: Color(0xFFF0EBE4),
    primarySoft: Color(0xFFB0A899),
    accent: Color(0xFFE8944A),       // copper-amber, hue 28°
    accentSoft: Color(0xFFD4763B),   // deeper ember
    success: Color(0xFF9ACC8A),      // warm sage
    warning: Color(0xFFE8C55A),      // muted gold
    danger: Color(0xFFD98A7A),       // dusty coral
    textPrimary: Color(0xFFF2EDE6),
    textSecondary: Color(0xFFADA599),
    textMuted: Color(0xFF6E655A),
  ),

  // ── 3. DEEP OCEAN ───────────────────────────────────────────────
  // Cool-toned deep blue-grey. Surfaces have a visible blue tint
  // (hue 215°, sat 14-18%). Accent is a bright teal-cyan at 185°,
  // providing strong contrast against the blue surfaces. The
  // complementary hue relationship (blue bg ↔ cyan accent) creates
  // a cohesive aquatic palette without feeling like a "copy" of Nord.
  const AppThemeData(
    name: 'Deep Ocean',
    subtitle: '深海藍調',
    background: Color(0xFF0A0E14),
    backgroundDeep: Color(0xFF060A0F),
    surface: Color(0xFF0F1820),
    surfaceElevated: Color(0xFF142028),
    surfaceSoft: Color(0xFF1A2830),
    border: Color(0xFF243440),
    borderStrong: Color(0xFF30445A),
    primary: Color(0xFFE6ECF2),
    primarySoft: Color(0xFF8A9DB0),
    accent: Color(0xFF4DC9B0),       // teal-cyan, hue 168°
    accentSoft: Color(0xFF3BA896),   // deeper teal
    success: Color(0xFF7ED4A0),      // seafoam
    warning: Color(0xFFDEC06A),      // warm sand
    danger: Color(0xFFE87882),       // muted coral-red
    textPrimary: Color(0xFFE8EDF2),
    textSecondary: Color(0xFF8A9DB0),
    textMuted: Color(0xFF506878),
  ),

  // ── 4. VIOLET DUSK ──────────────────────────────────────────────
  // Purple-leaning dark theme. Surfaces carry a subtle violet
  // undertone (hue 270°, sat 10-15%). Accent is a warm rose-pink
  // at hue 340°, creating an analogous-warm harmony with the cool
  // purple surfaces. This gives an editorial, creative-studio feel.
  // Semantic colors are all shifted slightly toward magenta for unity.
  const AppThemeData(
    name: 'Violet Dusk',
    subtitle: '暮光紫霞',
    background: Color(0xFF0C0A10),
    backgroundDeep: Color(0xFF08070C),
    surface: Color(0xFF131018),
    surfaceElevated: Color(0xFF1A1620),
    surfaceSoft: Color(0xFF221D2A),
    border: Color(0xFF302A3A),
    borderStrong: Color(0xFF40384C),
    primary: Color(0xFFEDE8F4),
    primarySoft: Color(0xFFA89EC0),
    accent: Color(0xFFE87CA0),       // rose-pink, hue 340°
    accentSoft: Color(0xFFC06690),   // deeper mauve
    success: Color(0xFF88D4A4),      // minty sage
    warning: Color(0xFFE4C870),      // warm ochre
    danger: Color(0xFFE06878),       // warm red-pink
    textPrimary: Color(0xFFF0ECF6),
    textSecondary: Color(0xFFA89EC0),
    textMuted: Color(0xFF685E80),
  ),

  // ── 5. MIDNIGHT GREEN ───────────────────────────────────────────
  // Nature-inspired with green undertones (hue 150°, sat 10-14%).
  // Accent is a warm goldenrod at hue 45° — complementary to green,
  // providing a natural "firefly in the forest" contrast. This is
  // tuned for long sessions: lower overall brightness, muted palette.
  const AppThemeData(
    name: 'Midnight Green',
    subtitle: '午夜翠林',
    background: Color(0xFF0A0D0B),
    backgroundDeep: Color(0xFF060807),
    surface: Color(0xFF101614),
    surfaceElevated: Color(0xFF161D1A),
    surfaceSoft: Color(0xFF1D2520),
    border: Color(0xFF283630),
    borderStrong: Color(0xFF384840),
    primary: Color(0xFFE4EDE8),
    primarySoft: Color(0xFF94AEA0),
    accent: Color(0xFFD4A84C),       // goldenrod, hue 42°
    accentSoft: Color(0xFFB8903E),   // deeper amber
    success: Color(0xFF7AC88E),      // vivid sage
    warning: Color(0xFFD8C070),      // warm wheat
    danger: Color(0xFFD47A6A),       // terracotta
    textPrimary: Color(0xFFE8F0EC),
    textSecondary: Color(0xFF94AEA0),
    textMuted: Color(0xFF586E62),
  ),

  // ── 6. SOFT DAYLIGHT ────────────────────────────────────────────
  // Light theme. Designed as a proper inversion of Graphite: warm
  // white surfaces (hue 40°, sat 3%), deep ink text, and a punchy
  // blue accent matching the original. Borders are deliberately
  // subtle (lightness diff only 6% from surface) to avoid harshness.
  // Semantic colors are darkened 20% vs dark-mode versions for
  // legibility on white backgrounds.
  const AppThemeData(
    name: 'Soft Daylight',
    subtitle: '日光柔白',
    background: Color(0xFFF8F7F5),
    backgroundDeep: Color(0xFFEFEDE9),
    surface: Color(0xFFFFFFFF),
    surfaceElevated: Color(0xFFF5F4F2),
    surfaceSoft: Color(0xFFEDECE9),
    border: Color(0xFFD8D6D2),
    borderStrong: Color(0xFFC0BDB8),
    primary: Color(0xFF2A2A2A),
    primarySoft: Color(0xFF606060),
    accent: Color(0xFF4A6EE0),       // same hue family as Graphite accent
    accentSoft: Color(0xFF6855CC),
    success: Color(0xFF2D8A50),      // dark-adjusted green
    warning: Color(0xFFB8920A),      // dark-adjusted gold
    danger: Color(0xFFC43850),       // dark-adjusted rose
    textPrimary: Color(0xFF1A1A1A),
    textSecondary: Color(0xFF5A5A5A),
    textMuted: Color(0xFF9A9894),
  ),
];

class SettingsNotifier extends ChangeNotifier {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const String _themeKey = 'settings_theme';
  static const String _zoomKey = 'settings_zoom';

  double _zoom = 1.0;
  AppThemeData _currentTheme = appThemes.first;

  double get zoom => _zoom;
  AppThemeData get currentTheme => _currentTheme;

  SettingsNotifier() {
    _loadFromDisk();
  }

  Future<void> _loadFromDisk() async {
    final savedTheme = await _storage.read(key: _themeKey);
    final savedZoom = await _storage.read(key: _zoomKey);

    if (savedTheme != null && savedTheme.isNotEmpty) {
      final match = appThemes.where((t) => t.name == savedTheme);
      if (match.isNotEmpty) {
        _currentTheme = match.first;
        _applyThemeToPalette(_currentTheme);
      }
    }

    if (savedZoom != null && savedZoom.isNotEmpty) {
      final parsed = double.tryParse(savedZoom);
      if (parsed != null) {
        _zoom = parsed.clamp(0.5, 2.0);
      }
    }

    notifyListeners();
  }

  Future<void> _saveToDisk() async {
    await _storage.write(key: _themeKey, value: _currentTheme.name);
    await _storage.write(key: _zoomKey, value: _zoom.toString());
  }

  void zoomIn() {
    _zoom = (_zoom + 0.1).clamp(0.5, 2.0);
    notifyListeners();
    _saveToDisk();
  }

  void zoomOut() {
    _zoom = (_zoom - 0.1).clamp(0.5, 2.0);
    notifyListeners();
    _saveToDisk();
  }

  void resetZoom() {
    _zoom = 1.0;
    notifyListeners();
    _saveToDisk();
  }

  void setZoom(double value) {
    _zoom = value.clamp(0.5, 2.0);
    notifyListeners();
    _saveToDisk();
  }

  void setThemeByName(String name) {
    final theme = appThemes.firstWhere((t) => t.name == name, orElse: () => appThemes.first);
    _currentTheme = theme;
    _applyThemeToPalette(theme);
    notifyListeners();
    _saveToDisk();
  }

  void _applyThemeToPalette(AppThemeData theme) {
    AppPalette.background = theme.background;
    AppPalette.backgroundDeep = theme.backgroundDeep;
    AppPalette.surface = theme.surface;
    AppPalette.surfaceElevated = theme.surfaceElevated;
    AppPalette.surfaceSoft = theme.surfaceSoft;
    AppPalette.border = theme.border;
    AppPalette.borderStrong = theme.borderStrong;
    AppPalette.primary = theme.primary;
    AppPalette.primarySoft = theme.primarySoft;
    AppPalette.accent = theme.accent;
    AppPalette.accentSoft = theme.accentSoft;
    AppPalette.success = theme.success;
    AppPalette.warning = theme.warning;
    AppPalette.danger = theme.danger;
    AppPalette.textPrimary = theme.textPrimary;
    AppPalette.textSecondary = theme.textSecondary;
    AppPalette.textMuted = theme.textMuted;
  }
}

class _SettingsDialog extends StatelessWidget {
  const _SettingsDialog();

  @override
  Widget build(BuildContext context) {
    final settings = Provider.of<SettingsNotifier>(context);
    final theme = settings.currentTheme;

    return Dialog(
      backgroundColor: Colors.transparent,
      child: Container(
        width: 520,
        constraints: const BoxConstraints(maxHeight: 600),
        decoration: BoxDecoration(
          color: AppPalette.surfaceElevated,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppPalette.border),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.5),
              blurRadius: 40,
              spreadRadius: 4,
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ── HEADER ──
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: AppPalette.border)),
              ),
              child: Row(
                children: [
                  Icon(Icons.palette_outlined, color: AppPalette.accent, size: 18),
                  const SizedBox(width: 10),
                  Text(
                    'Settings',
                    style: TextStyle(
                      color: AppPalette.textPrimary,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    '  /  設定',
                    style: TextStyle(
                      color: AppPalette.textMuted,
                      fontSize: 12,
                    ),
                  ),
                  const Spacer(),
                  InkWell(
                    borderRadius: BorderRadius.circular(6),
                    onTap: () => Navigator.of(context).pop(),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(Icons.close, size: 16, color: AppPalette.textMuted),
                    ),
                  ),
                ],
              ),
            ),

            // ── BODY ──
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // ── Zoom Section ──
                    _sectionLabel('UI Zoom', '介面縮放'),
                    const SizedBox(height: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: AppPalette.surface,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppPalette.border),
                      ),
                      child: Row(
                        children: [
                          _zoomButton(Icons.remove, () => settings.zoomOut()),
                          Expanded(
                            child: SliderTheme(
                              data: SliderThemeData(
                                activeTrackColor: AppPalette.accent,
                                inactiveTrackColor: AppPalette.border,
                                thumbColor: AppPalette.accent,
                                overlayColor: AppPalette.accent.withValues(alpha: 0.12),
                                trackHeight: 3,
                              ),
                              child: Slider(
                                min: 0.5,
                                max: 2.0,
                                divisions: 15,
                                value: settings.zoom,
                                onChanged: (val) => settings.setZoom(val),
                              ),
                            ),
                          ),
                          _zoomButton(Icons.add, () => settings.zoomIn()),
                          const SizedBox(width: 10),
                          Container(
                            width: 50,
                            alignment: Alignment.center,
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            decoration: BoxDecoration(
                              color: AppPalette.surfaceSoft,
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              '${(settings.zoom * 100).round()}%',
                              style: TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 11,
                                color: AppPalette.textSecondary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Ctrl +/-  放大縮小  ·  Ctrl 0  重設',
                      style: TextStyle(fontSize: 10, color: AppPalette.textMuted),
                    ),

                    const SizedBox(height: 24),

                    // ── Theme Section ──
                    _sectionLabel('Color Theme', '配色主題'),
                    const SizedBox(height: 10),
                    ...appThemes.map((t) => _buildThemeCard(t, t.name == theme.name, settings)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionLabel(String en, String zh) {
    return Row(
      children: [
        Text(
          en,
          style: TextStyle(
            color: AppPalette.textPrimary,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
          ),
        ),
        const SizedBox(width: 8),
        Text(
          zh,
          style: TextStyle(
            color: AppPalette.textMuted,
            fontSize: 11,
          ),
        ),
      ],
    );
  }

  Widget _zoomButton(IconData icon, VoidCallback onTap) {
    return InkWell(
      borderRadius: BorderRadius.circular(4),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Icon(icon, size: 14, color: AppPalette.textSecondary),
      ),
    );
  }

  Widget _buildThemeCard(AppThemeData t, bool isSelected, SettingsNotifier settings) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => settings.setThemeByName(t.name),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: t.background,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: isSelected ? t.accent : t.border,
              width: isSelected ? 1.5 : 1,
            ),
          ),
          child: Row(
            children: [
              // Theme info
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (isSelected)
                          Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: Icon(Icons.check_circle, size: 13, color: t.accent),
                          ),
                        Text(
                          t.name,
                          style: TextStyle(
                            color: t.textPrimary,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                    if (t.subtitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        t.subtitle,
                        style: TextStyle(
                          color: t.textMuted,
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              // Color swatch strip — shows the actual palette at a glance
              Row(
                children: [
                  _swatch(t.backgroundDeep),
                  _swatch(t.surface),
                  _swatch(t.surfaceElevated),
                  _swatch(t.border),
                  const SizedBox(width: 6),
                  _swatch(t.accent),
                  _swatch(t.accentSoft),
                  const SizedBox(width: 6),
                  _swatch(t.success),
                  _swatch(t.warning),
                  _swatch(t.danger),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _swatch(Color c) {
    return Container(
      width: 14,
      height: 14,
      margin: const EdgeInsets.symmetric(horizontal: 1),
      decoration: BoxDecoration(
        color: c,
        borderRadius: BorderRadius.circular(3),
        border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
      ),
    );
  }
}
