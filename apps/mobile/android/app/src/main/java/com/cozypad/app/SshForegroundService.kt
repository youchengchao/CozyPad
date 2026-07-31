package com.cozypad.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * 前景服務：Android 會凍結進入背景的程序並中斷 socket，
 * 有前景服務（含常駐通知）才能在切換 app／關螢幕時維持 SSH 連線。
 *
 * 這不是萬靈丹——記憶體壓力下仍可能被回收，Android 15 對 dataSync 類型
 * 另有每日總時長上限。真正的保險是遠端 tmux：重連後接回去。
 */
class SshForegroundService : android.app.Service() {

    companion object {
        private const val CHANNEL_ID = "cozypad_connection"
        private const val NOTIFICATION_ID = 1001
        private const val EXTRA_HOST = "host"

        fun start(context: Context, host: String) {
            val intent = Intent(context, SshForegroundService::class.java).putExtra(EXTRA_HOST, host)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SshForegroundService::class.java))
        }
    }

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val host = intent?.getStringExtra(EXTRA_HOST) ?: "remote host"
        createChannel()

        val tapIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CozyPad 連線中")
            .setContentText(host)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(tapIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        // NOT_STICKY：SSH client 活在 app 程序裡，程序被回收後服務自行復活
        // 只會顯示一個「連線中」卻沒有連線的假通知。
        return START_NOT_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "遠端連線",
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = "維持 SSH 連線在背景執行"
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }
}
