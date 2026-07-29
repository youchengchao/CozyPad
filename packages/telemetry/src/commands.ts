/** 與 Flutter 版（lib/providers/ssh_provider.dart）完全相同的遠端命令與標記。 */

export const CPU_SPLIT_MARKER = '__DASHBOARD_CPU_SPLIT__';

export const CPU_COMMAND = `cat /proc/stat; echo ${CPU_SPLIT_MARKER}; sleep 0.35; cat /proc/stat`;

export const MEMORY_COMMAND = `free -m | awk '/^Mem:/ {print $3 "," $2}'`;

export const GPU_APP_SPLIT_MARKER = '__DASHBOARD_GPU_APP_SPLIT__';
export const GPU_PS_SPLIT_MARKER = '__DASHBOARD_PS_SPLIT__';

export const GPU_COMMAND = `if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true
  printf '\\n${GPU_APP_SPLIT_MARKER}\\n'
  nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true
  printf '\\n${GPU_PS_SPLIT_MARKER}\\n'
  ps -eo pid=,user=,etimes=,args= 2>/dev/null | awk '
    {
      pid=$1;
      user=$2;
      etimes=$3;
      sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]*/, "", $0);
      gsub(/\\t/, " ", $0);
      gsub(/[[:space:]][[:space:]]+/, " ", $0);
      if (pid != "") printf "__PS__\\t%s\\t%s\\t%s\\t%s\\n", pid, user, etimes, $0;
    }
  ' || true
else
  true
fi`;
