package com.cozypad.app

internal object DownloadFilePolicy {
    private val mimeTypes = mapOf(
        "css" to "text/css",
        "csv" to "text/csv",
        "gif" to "image/gif",
        "gz" to "application/gzip",
        "htm" to "text/html",
        "html" to "text/html",
        "jpeg" to "image/jpeg",
        "jpg" to "image/jpeg",
        "js" to "application/javascript",
        "json" to "application/json",
        "log" to "text/plain",
        "markdown" to "text/markdown",
        "md" to "text/markdown",
        "mjs" to "application/javascript",
        "pdf" to "application/pdf",
        "png" to "image/png",
        "svg" to "image/svg+xml",
        "tar" to "application/x-tar",
        "tsv" to "text/tab-separated-values",
        "txt" to "text/plain",
        "webp" to "image/webp",
        "xml" to "application/xml",
        "yaml" to "application/yaml",
        "yml" to "application/yaml",
        "zip" to "application/zip",
    )

    fun requireSafeFileName(value: String?): String {
        require(!value.isNullOrEmpty()) { "Download filename is required" }
        require(value.length <= 255) { "Download filename is too long" }
        require(value != "." && value != "..") { "Unsafe download filename" }
        require('/' !in value) { "Unsafe download filename" }
        require(value.none { it.code < 32 || it.code == 127 }) {
            "Unsafe download filename"
        }
        return value
    }

    fun resolveMimeType(fileName: String, supplied: String?): String {
        val safeSupplied = supplied?.takeIf { mime ->
            mime.length in 3..127 &&
                mime.count { it == '/' } == 1 &&
                mime.none { it.isWhitespace() || it.code < 32 || it.code == 127 }
        }
        if (safeSupplied != null) return safeSupplied

        val extension = fileName.substringAfterLast('.', "").lowercase()
        return mimeTypes[extension] ?: "application/octet-stream"
    }
}
