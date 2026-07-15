part of cozypad;

/* =========================================================
   Tasks Tab
========================================================= */

class TasksTab extends StatelessWidget {
  const TasksTab({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<SSHProvider>();

    return RefreshIndicator(
      onRefresh: provider.refreshAll,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionTitle('Tasks (${provider.tasks.length})'),
          const SizedBox(height: 12),
          if (provider.tasks.isEmpty)
            const InfoCard(
              text: 'No tasks found. Expected file: ~/.dashboard_tasks.json',
            )
          else
            ...provider.tasks.map((task) => TaskCard(task: task)),
        ],
      ),
    );
  }
}

