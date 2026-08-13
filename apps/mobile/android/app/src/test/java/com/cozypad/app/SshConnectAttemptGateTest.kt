package com.cozypad.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshConnectAttemptGateTest {
    @Test
    fun newerAttemptSupersedesOlderAttempt() {
        val gate = SshConnectAttemptGate()
        val older = gate.begin()
        val newer = gate.begin()

        assertFalse(gate.isCurrent(older))
        assertTrue(gate.isCurrent(newer))
    }

    @Test
    fun staleAttemptCannotMutateCurrentConnection() {
        val gate = SshConnectAttemptGate()
        val older = gate.begin()
        val newer = gate.begin()
        var owner = "none"

        assertFalse(gate.runIfCurrent(older) { owner = "older" })
        assertTrue(gate.runIfCurrent(newer) { owner = "newer" })
        assertTrue(owner == "newer")
    }

    @Test
    fun disconnectInvalidatesCurrentAttempt() {
        val gate = SshConnectAttemptGate()
        val attempt = gate.begin()

        gate.invalidate()

        assertFalse(gate.isCurrent(attempt))
        assertFalse(gate.runIfCurrent(attempt) {})
    }
}
