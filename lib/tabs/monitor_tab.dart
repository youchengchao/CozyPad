part of ssh_dashboard;

/* =========================================================
   Monitor Tab (Minimalist Vercel / shadcn-style redesign)
========================================================= */

class MonitorTab extends StatefulWidget {
  const MonitorTab({super.key});

  @override
  State<MonitorTab> createState() => _MonitorTabState();
}

class _MonitorTabState extends State<MonitorTab> {
  String _timeLabel(DateTime? time) {
    if (time == null) return 'No sync';
    final hour = time.hour.toString().padLeft(2, '0');
    final minute = time.minute.toString().padLeft(2, '0');
    final second = time.second.toString().padLeft(2, '0');
    return 'Synced at $hour:$minute:$second';
  }

  String _cpuSubtitle(CpuMetric cpu) {
    if (cpu.cores.isEmpty) return 'CPU Info';
    final busiest = cpu.cores.reduce((a, b) => a.usage >= b.usage ? a : b);
    return '${cpu.cores.length} cores · busiest: ${busiest.usage.toStringAsFixed(0)}%';
  }

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
          title: const Text('Process Command'),
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
    final provider = context.watch<SSHProvider>();

    return RefreshIndicator(
      onRefresh: provider.refreshAll,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        children: [
          _buildHeader(provider),
          if (provider.errorMessage != null) ...[
            ErrorCard(message: provider.errorMessage!),
            const SizedBox(height: 16),
          ],
          ResponsiveGrid(
            itemCount: 3,
            minItemWidth: 220,
            childAspectRatio: 2.1,
            itemBuilder: (context, index) {
              if (index == 0) {
                return _buildCpuCard(provider);
              } else if (index == 1) {
                return _buildMemoryCard(provider);
              } else {
                return _buildGpuOverviewCard(provider);
              }
            },
          ),
          _buildGpuDeviceList(provider),
          _buildActiveProcesses(provider),
        ],
      ),
    );
  }

  Widget _buildHeader(SSHProvider provider) {
    final statusText = provider.isConnected
        ? (provider.isPolling ? 'Updating...' : _timeLabel(provider.lastUpdated))
        : 'Disconnected';

    return Padding(
      padding: const EdgeInsets.only(bottom: 16, left: 2, right: 2),
      child: Row(
        children: [
          Icon(
            Icons.dns_outlined,
            size: 15,
            color: provider.isConnected ? AppPalette.textSecondary : AppPalette.textMuted,
          ),
          const SizedBox(width: 8),
          Text(
            provider.connectedHost ?? 'Disconnected Host',
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 14,
              color: AppPalette.textPrimary,
              letterSpacing: -0.1,
            ),
          ),
          const SizedBox(width: 10),
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: provider.isConnected ? AppPalette.success : AppPalette.danger,
              shape: BoxShape.circle,
            ),
          ),
          const Spacer(),
          Text(
            statusText,
            style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: AppPalette.textMuted),
          ),
          const SizedBox(width: 8),
          IconButton(
            icon: provider.isPolling
                ? const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 1.5, color: AppPalette.textMuted),
                  )
                : const Icon(Icons.refresh, size: 14),
            tooltip: 'Refresh metrics',
            color: AppPalette.textMuted,
            onPressed: provider.isPolling ? null : provider.refreshAll,
          ),
        ],
      ),
    );
  }

  Widget _buildCpuCard(SSHProvider provider) {
    final cpuUsage = provider.cpu.totalUsage;
    final busiestSubtitle = _cpuSubtitle(provider.cpu);

    return _FlatCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'CPU TOTAL',
                style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textMuted, letterSpacing: 0.5),
              ),
              Icon(Icons.memory_rounded, size: 14, color: AppPalette.textMuted.withOpacity(0.8)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${cpuUsage.toStringAsFixed(1)}%',
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
          ),
          const SizedBox(height: 4),
          Text(
            busiestSubtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: AppPalette.textMuted),
          ),
          const SizedBox(height: 12),
          _MiniProgressBar(progress: cpuUsage / 100, color: AppPalette.textSecondary),
        ],
      ),
    );
  }

  Widget _buildMemoryCard(SSHProvider provider) {
    final usedGb = provider.memory.usedMb / 1024;
    final totalGb = provider.memory.totalMb / 1024;
    final usagePercent = provider.memory.usagePercent;

    return _FlatCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'SYSTEM MEMORY',
                style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textMuted, letterSpacing: 0.5),
              ),
              Icon(Icons.storage_rounded, size: 14, color: AppPalette.textMuted.withOpacity(0.8)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${usagePercent.toStringAsFixed(1)}%',
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
          ),
          const SizedBox(height: 4),
          Text(
            '${usedGb.toStringAsFixed(1)} / ${totalGb.toStringAsFixed(1)} GB used',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: AppPalette.textMuted),
          ),
          const SizedBox(height: 12),
          _MiniProgressBar(progress: usagePercent / 100, color: AppPalette.textSecondary),
        ],
      ),
    );
  }

  Widget _buildGpuOverviewCard(SSHProvider provider) {
    final gpuCount = provider.gpus.length;
    final activeProcesses = provider.gpus.fold<int>(0, (sum, g) => sum + g.processCount);
    final avgGpuUtil = gpuCount == 0 
        ? 0.0 
        : provider.gpus.fold<double>(0, (sum, g) => sum + g.usage) / gpuCount;
        
    return _FlatCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'GPU CLUSTER',
                style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textMuted, letterSpacing: 0.5),
              ),
              Icon(Icons.developer_board_outlined, size: 14, color: AppPalette.textMuted.withOpacity(0.8)),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            gpuCount == 0 ? 'N/A' : '${avgGpuUtil.toStringAsFixed(0)}% avg',
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
          ),
          const SizedBox(height: 4),
          Text(
            gpuCount == 0 
                ? 'No GPUs detected' 
                : '$gpuCount device${gpuCount == 1 ? '' : 's'} · $activeProcesses proc',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: AppPalette.textMuted),
          ),
          const SizedBox(height: 12),
          _MiniProgressBar(progress: avgGpuUtil / 100, color: AppPalette.textSecondary),
        ],
      ),
    );
  }

  Widget _buildGpuDeviceList(SSHProvider provider) {
    if (provider.gpus.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(2, 18, 0, 8),
          child: Text(
            'GPU HARDWARE STATUS',
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              color: AppPalette.textMuted,
              letterSpacing: 0.5,
            ),
          ),
        ),
        _FlatCard(
          padding: EdgeInsets.zero,
          child: ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: provider.gpus.length,
            separatorBuilder: (_, __) => const Divider(height: 1, color: AppPalette.border),
            itemBuilder: (context, index) {
              final gpu = provider.gpus[index];
              return Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppPalette.border,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            'GPU ${gpu.index}',
                            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textPrimary, fontFamily: 'monospace'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            gpu.name,
                            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppPalette.textPrimary),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '${gpu.temperature.toStringAsFixed(0)}°C',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.bold,
                            color: gpu.temperature > 80 
                                ? AppPalette.danger 
                                : (gpu.temperature > 65 ? AppPalette.warning : AppPalette.success),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          flex: 1,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('CORE UTIL', style: TextStyle(fontSize: 9, color: AppPalette.textMuted)),
                                  Text('${gpu.usage.toStringAsFixed(0)}%', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textSecondary)),
                                ],
                              ),
                              const SizedBox(height: 4),
                              _MiniProgressBar(progress: gpu.usage / 100, color: AppPalette.textSecondary),
                            ],
                          ),
                        ),
                        const SizedBox(width: 24),
                        Expanded(
                          flex: 1,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  const Text('VRAM USE', style: TextStyle(fontSize: 9, color: AppPalette.textMuted)),
                                  Text(
                                    '${(gpu.memoryUsedMb / 1024).toStringAsFixed(1)} / ${(gpu.memoryTotalMb / 1024).toStringAsFixed(1)} GB',
                                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: AppPalette.textSecondary, fontFamily: 'monospace'),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 4),
                              _MiniProgressBar(progress: gpu.memoryUsagePercent / 100, color: AppPalette.textSecondary),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildActiveProcesses(SSHProvider provider) {
    final allProcesses = <_GpuProcessItem>[];
    for (final gpu in provider.gpus) {
      for (final proc in gpu.processes) {
        allProcesses.add(_GpuProcessItem(gpuIndex: gpu.index, process: proc));
      }
    }

    if (allProcesses.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(2, 18, 0, 8),
            child: Text(
              'ACTIVE COMPUTE PROCESSES',
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w800,
                color: AppPalette.textMuted,
                letterSpacing: 0.5,
              ),
            ),
          ),
          _FlatCard(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: const [
                  Icon(Icons.nightlight_round, size: 14, color: AppPalette.textMuted),
                  SizedBox(width: 8),
                  Text(
                    'No running compute processes',
                    style: TextStyle(fontSize: 12, color: AppPalette.textMuted),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(2, 18, 0, 8),
          child: Text(
            'ACTIVE COMPUTE PROCESSES',
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              color: AppPalette.textMuted,
              letterSpacing: 0.5,
            ),
          ),
        ),
        _FlatCard(
          padding: EdgeInsets.zero,
          child: ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: allProcesses.length,
            separatorBuilder: (_, __) => const Divider(height: 1, color: AppPalette.border),
            itemBuilder: (context, index) {
              final item = allProcesses[index];
              final proc = item.process;
              final hasDetailedCommand = proc.commandLine.trim().isNotEmpty && proc.commandLine.trim() != proc.shortName;

              return InkWell(
                onTap: hasDetailedCommand 
                    ? () => _showCommandDialog(context, proc) 
                    : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1.5),
                        decoration: BoxDecoration(
                          color: AppPalette.border,
                          borderRadius: BorderRadius.circular(3),
                        ),
                        child: Text(
                          'GPU ${item.gpuIndex}',
                          style: const TextStyle(fontSize: 9, color: AppPalette.textSecondary, fontFamily: 'monospace'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'PID ${proc.pid}',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppPalette.textPrimary, fontFamily: 'monospace'),
                          ),
                          Text(
                            proc.username,
                            style: const TextStyle(fontSize: 10, color: AppPalette.textMuted),
                          ),
                        ],
                      ),
                      const SizedBox(width: 24),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              proc.shortName,
                              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppPalette.textPrimary),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (hasDetailedCommand)
                              const Text(
                                'Click to view full launch command',
                                style: TextStyle(fontSize: 9, color: AppPalette.accent),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '${proc.usedMemoryMb.toStringAsFixed(0)} MB',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: AppPalette.textPrimary, fontFamily: 'monospace'),
                          ),
                          Text(
                            proc.runtimeLabel,
                            style: const TextStyle(fontSize: 10, color: AppPalette.textMuted),
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
    );
  }
}

class _FlatCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;

  const _FlatCard({required this.child, this.padding});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding ?? const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppPalette.surface,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppPalette.border),
      ),
      child: child,
    );
  }
}

class _MiniProgressBar extends StatelessWidget {
  final double progress;
  final Color? color;

  const _MiniProgressBar({required this.progress, this.color});

  @override
  Widget build(BuildContext context) {
    final safeProgress = progress.clamp(0.0, 1.0);
    return ClipRRect(
      borderRadius: BorderRadius.circular(2),
      child: SizedBox(
        height: 3,
        child: LinearProgressIndicator(
          value: safeProgress,
          backgroundColor: AppPalette.border,
          valueColor: AlwaysStoppedAnimation<Color>(color ?? AppPalette.textSecondary),
        ),
      ),
    );
  }
}

class _GpuProcessItem {
  final int gpuIndex;
  final GpuProcessMetric process;

  const _GpuProcessItem({
    required this.gpuIndex,
    required this.process,
  });
}
