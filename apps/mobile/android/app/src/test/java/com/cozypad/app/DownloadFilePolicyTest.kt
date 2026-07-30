package com.cozypad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DownloadFilePolicyTest {
    @Test
    fun `preserves safe remote filenames exactly`() {
        assertEquals(
            "weights.final.safetensors",
            DownloadFilePolicy.requireSafeFileName("weights.final.safetensors"),
        )
    }

    @Test
    fun `rejects path traversal and control characters`() {
        for (fileName in listOf("../secret", "folder/file.txt", "bad\nname.txt")) {
            assertThrows(IllegalArgumentException::class.java) {
                DownloadFilePolicy.requireSafeFileName(fileName)
            }
        }
    }

    @Test
    fun `uses binary MIME instead of guessing XML for unknown files`() {
        assertEquals(
            "application/octet-stream",
            DownloadFilePolicy.resolveMimeType("weights.safetensors", null),
        )
        assertEquals(
            "application/octet-stream",
            DownloadFilePolicy.resolveMimeType("Makefile", null),
        )
    }

    @Test
    fun `keeps known and explicitly supplied MIME types`() {
        assertEquals(
            "application/pdf",
            DownloadFilePolicy.resolveMimeType("paper.pdf", null),
        )
        assertEquals(
            "application/x-custom",
            DownloadFilePolicy.resolveMimeType("artifact.bin", "application/x-custom"),
        )
    }
}
