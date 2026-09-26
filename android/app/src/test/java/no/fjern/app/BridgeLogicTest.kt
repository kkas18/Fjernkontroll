package no.fjern.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.SocketTimeoutException
import java.nio.file.Files
import kotlin.concurrent.thread

class BridgeLogicTest {
    @Test fun `bare private IPv4-adresser godtas`() {
        listOf("10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.42").forEach { assertTrue(it, Validate.isPrivateIPv4(it)) }
        listOf("127.0.0.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "256.1.1.1", "x", null).forEach { assertFalse("$it", Validate.isPrivateIPv4(it)) }
    }

    @Test fun `enheter, kommandoer, tekst og app-id valideres`() {
        assertEquals(Device("lg", "192.168.1.2", "LG webOS"), Validate.device("lg", "192.168.1.2", ""))
        assertEquals(70, Validate.device("roku", "10.0.0.5", "x".repeat(200)).name.length)
        assertThrows { Validate.device("sony", "192.168.1.2", null) }
        assertThrows { Validate.device("roku", "8.8.8.8", null) }
        assertEquals("PowerOn", Validate.command("PowerOn"))
        assertThrows { Validate.command("rm -rf") }
        assertEquals(140, Validate.text("a".repeat(500)).length)
        assertThrows { Validate.text("   ") }
        assertThrows { Validate.appId("../x") }
    }

    @Test fun `alle kommandoer har en Roku-tast, og pause veksler`() {
        Validate.COMMANDS.forEach { assertTrue(it, Roku.KEYS.containsKey(it)) }
        assertEquals("Rev", Roku.KEYS["Rewind"])
        assertEquals("Fwd", Roku.KEYS["FastForward"])
        assertEquals("Play", Roku.KEYS["Pause"])
    }

    @Test fun `Roku device-info og applister parses`() {
        val tv = Roku.parseDeviceInfo("192.168.1.5", "<user-device-name>Stue &amp; kjøkken</user-device-name><is-tv>true</is-tv>")
        assertEquals(Device("roku", "192.168.1.5", "Stue & kjøkken", true), tv)
        assertEquals(false, Roku.parseDeviceInfo("192.168.1.6", "<is-tv>false</is-tv>").isTv)
        val apps = Roku.parseApps("""<app id="12" type="appl">Netflix</app><app id="bad id">X</app><app id="837">YouTube</app>""")
        assertEquals(listOf(App("12", "Netflix"), App("837", "YouTube")), apps)
        assertEquals(48, Roku.parseApps((0 until 100).joinToString("") { """<app id="$it">A$it</app>""" }).size)
    }

    @Test fun `SSDP gjenkjenner TV-er og har tak`() {
        assertEquals("roku", Ssdp.classify("ST: roku:ecp", "192.168.1.2")?.type)
        assertEquals("lg", Ssdp.classify("SERVER: WebOS/4.1", "10.0.0.3")?.type)
        assertNull(Ssdp.classify("ST: roku:ecp", "8.8.8.8"))
        val collector = Ssdp.Collector()
        for (i in 0 until 300) collector.add("roku", "192.168.${i shr 8}.${i and 255}")
        assertEquals(Ssdp.MAX_DEVICES, collector.devices().size)
    }

    @Test fun `Wake-on-LAN-pakken har riktig format`() {
        assertEquals("a8:23:fe:01:02:03", Wol.normalizeMac("A8-23-FE-01-02-03"))
        assertNull(Wol.normalizeMac("ikke en mac"))
        val packet = Wol.magicPacket("a8:23:fe:01:02:03")
        assertEquals(102, packet.size)
        assertArrayEquals(ByteArray(6) { 0xFF.toByte() }, packet.copyOfRange(0, 6))
        assertArrayEquals(byteArrayOf(0xa8.toByte(), 0x23, 0xfe.toByte(), 0x01, 0x02, 0x03), packet.copyOfRange(96, 102))
    }

    @Test fun `feil oversettes til norsk`() {
        assertEquals(504, toUserMessage(SocketTimeoutException()).status)
        assertEquals(UserMessage(409, "Hei", false), toUserMessage(UserError("Hei", 409)))
        assertTrue(toUserMessage(IllegalStateException("hemmelig")).internal)
    }

    @Test fun `nøkkellager taper ikke samtidige skrivinger`() {
        val dir = Files.createTempDirectory("fjern").toFile()
        val store = KeyStore(File(dir, "lg-keys.json"))
        val threads = (0 until 10).map { i -> thread { store.update("10.0.0.$i", key = "k$i") } }
        threads.forEach { it.join() }
        (0 until 10).forEach { assertEquals("k$it", store.get("10.0.0.$it")?.key) }
        store.update("10.0.0.1", fingerprint = "AA:BB", mac = "a8:23:fe:01:02:03")
        assertEquals(KeyStore.Entry("k1", "AA:BB", "a8:23:fe:01:02:03"), store.get("10.0.0.1"))
        store.remove("10.0.0.1")
        assertNull(store.get("10.0.0.1"))
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
        dir.deleteRecursively()
    }

    @Test fun `LG-registreringen ber om navigasjonstillatelse og parer på nytt ved gamle nøkler`() {
        assertTrue(LgSession.PERMISSIONS.contains("CONTROL_MOUSE_AND_KEYBOARD"))
        val fresh = LgSession.registrationPayload(null)
        assertEquals("PROMPT", fresh.getString("pairingType"))
        assertFalse(fresh.getJSONObject("manifest").has("signatures"))
        assertEquals(LgSession.PERMISSIONS.size, fresh.getJSONObject("manifest").getJSONArray("permissions").length())
        assertFalse(fresh.has("client-key"))
        assertFalse(LgSession.registrationPayload(KeyStore.Entry(key = "gammel")).has("client-key"))
        assertEquals("ny", LgSession.registrationPayload(KeyStore.Entry(key = "ny", rev = LgSession.MANIFEST_REVISION)).getString("client-key"))
    }

    @Test fun `nøkkelrevisjon lagres og leses`() {
        val dir = Files.createTempDirectory("fjern").toFile()
        val store = KeyStore(File(dir, "lg-keys.json"))
        store.update("10.0.0.1", key = "k", rev = 2)
        assertEquals(2, store.get("10.0.0.1")?.rev)
        store.update("10.0.0.2", key = "gammel")
        assertEquals(0, store.get("10.0.0.2")?.rev)
        dir.deleteRecursively()
    }

    @Test fun `feilsøkingsloggen har tak`() {
        repeat(200) { Diagnostics.add("linje $it") }
        val lines = Diagnostics.snapshot()
        assertEquals(150, lines.size)
        assertTrue(lines.last().endsWith("linje 199"))
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: UserError) {
            return
        }
        throw AssertionError("Forventet UserError")
    }
}
