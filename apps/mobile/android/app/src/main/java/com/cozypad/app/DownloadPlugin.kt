package com.cozypad.app

import android.app.Activity
import android.annotation.TargetApi
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "CozyPadDownload")
class DownloadPlugin : Plugin() {
    @PluginMethod
    fun saveFile(call: PluginCall) {
        val fileName = try {
            DownloadFilePolicy.requireSafeFileName(call.getString("fileName"))
        } catch (error: IllegalArgumentException) {
            call.reject(error.message ?: "Unsafe download filename")
            return
        }
        val dataBase64 = call.getString("dataBase64")
        if (dataBase64 == null) {
            call.reject("Download data is required")
            return
        }
        val mimeType = DownloadFilePolicy.resolveMimeType(
            fileName,
            call.getString("mimeType"),
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            bridge.execute {
                val bytes = decode(call, dataBase64) ?: return@execute
                saveToDownloads(call, fileName, mimeType, bytes)
            }
            return
        }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, fileName)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        bridge.executeOnMainThread {
            startActivityForResult(call, intent, "saveDocumentResult")
        }
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private fun saveToDownloads(
        call: PluginCall,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
    ) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/CozyPad",
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            call.reject("Unable to create the downloaded file")
            return
        }

        try {
            val output = resolver.openOutputStream(uri, "w")
                ?: throw IllegalStateException("Output stream unavailable")
            output.use { it.write(bytes) }

            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            if (resolver.update(uri, values, null, null) != 1) {
                throw IllegalStateException("Unable to publish downloaded file")
            }
            resolveSaved(call, fileName, "Downloads/CozyPad")
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            call.reject("Unable to save the downloaded file", error)
        }
    }

    @ActivityCallback
    private fun saveDocumentResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) {
            call.resolve(
                JSObject().apply {
                    put("fileName", call.getString("fileName") ?: "download")
                    put("cancelled", true)
                },
            )
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            call.reject("The selected download destination is unavailable")
            return
        }

        bridge.execute {
            val dataBase64 = call.getString("dataBase64")
            if (dataBase64 == null) {
                call.reject("Download data is required")
                return@execute
            }
            val bytes = decode(call, dataBase64) ?: return@execute
            try {
                val output = context.contentResolver.openOutputStream(uri, "w")
                    ?: throw IllegalStateException("Output stream unavailable")
                output.use { it.write(bytes) }
                resolveSaved(
                    call,
                    call.getString("fileName") ?: "download",
                    "Selected location",
                )
            } catch (error: Exception) {
                call.reject("Unable to save the downloaded file", error)
            }
        }
    }

    private fun decode(call: PluginCall, encoded: String): ByteArray? {
        return try {
            Base64.decode(encoded, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            call.reject("Downloaded file data is invalid")
            null
        }
    }

    private fun resolveSaved(
        call: PluginCall,
        fileName: String,
        location: String,
    ) {
        call.resolve(
            JSObject().apply {
                put("fileName", fileName)
                put("cancelled", false)
                put("location", location)
            },
        )
    }
}
