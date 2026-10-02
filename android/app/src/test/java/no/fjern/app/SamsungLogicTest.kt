package no.fjern.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

/** Samme regler som tests/samsung.test.mjs for Node-broen. */
class SamsungLogicTest {
    private val host = "192.168.1.50"

    @Test fun `adresse, navn og meldinger følger Samsungs fjernkontroll-API`() {
        assertEquals("Fjern", String(Base64.getDecoder().decode(SamsungSession.REMOTE_NAME)))
        assertEquals("wss://$host:8002/api/v2/channels/samsung.remote.control?name=Rmplcm4%3D&token=123", SamsungSession.remoteUrl(host, secure = true, token = "123"))
        // Tokenet sendes aldri ukryptert.
        assertEquals("ws://$host:8001/api/v2/channels/samsung.remote.control?name=Rmplcm4%3D", SamsungSession.remoteUrl(host, secure = false, token = "123"))
        val key = SamsungSession.keyMessage("KEY_UP")
        assertEquals("ms.remote.control", key.getString("method"))
        assertEquals("KEY_UP", key.getJSONObject("params").getString("DataOfCmd"))
        assertEquals("SendRemoteKey", key.getJSONObject("params").getString("TypeOfRemote"))
        val emit = SamsungSession.emitMessage("ed.apps.launch", JSONObject().put("appId", "x"))
        assertEquals("host", emit.getJSONObject("params").getString("to"))
        assertEquals("samsung:$host", SamsungSession.storeKey(host))
    }

    @Test fun `alle ekstra taster har en Samsung-tast, og alle tastene er gyldige kommandoer`() {
        SamsungSession.EXTRA_KEYS.forEach { assertTrue(it, SamsungSession.KEYS.containsKey(it)) }
        SamsungSession.KEYS.keys.forEach { assertTrue(it, it in Validate.COMMANDS) }
        assertEquals("KEY_CYAN", SamsungSession.KEYS["Blue"])
        assertEquals("KEY_7", SamsungSession.KEYS["Num7"])
        assertEquals(listOf("KEY_SOURCE", "KEY_HDMI1", "KEY_HDMI2", "KEY_HDMI3", "KEY_HDMI4"), SamsungSession.INPUTS.map { it.id })
    }

    @Test fun `TV-info leses fra REST-API-et`() {
        val body = JSONObject().put("device", JSONObject()
            .put("name", "[TV] Stue").put("modelName", "QE55Q80B").put("wifiMac", "A0:D0:5B:01:02:03")
            .put("TokenAuthSupport", "true").put("PowerState", "on")).toString()
        assertEquals(SamsungInfo("Stue", "QE55Q80B", "a0:d0:5b:01:02:03", true, "on"), SamsungSession.parseInfo(body))
        assertNull(SamsungSession.parseInfo(JSONObject().put("device", JSONObject().put("TokenAuthSupport", "x")).toString()).tokenAuth)
        try { SamsungSession.parseInfo("{\"hei\":1}"); throw AssertionError("forventet feil") } catch (_: UserError) {}
        try { SamsungSession.parseInfo("<html>"); throw AssertionError("forventet feil") } catch (_: UserError) {}
    }

    @Test fun `appene parses med gyldige id-er, starttype og tak`() {
        val list = JSONArray()
            .put(JSONObject().put("appId", "111299001912").put("app_type", 2).put("name", "YouTube"))
            .put(JSONObject().put("appId", "org.tizen.browser").put("app_type", 4).put("name", "Internett"))
            .put(JSONObject().put("appId", "../x").put("name", "x"))
        val apps = SamsungSession.parseApps(list)
        assertEquals(listOf("111299001912" to "DEEP_LINK", "org.tizen.browser" to "NATIVE_LAUNCH"), apps.map { it.first.id to it.second })
        val many = JSONArray().also { array -> repeat(100) { array.put(JSONObject().put("appId", "app$it")) } }
        assertEquals(Validate.MAX_APPS, SamsungSession.parseApps(many).size)
        assertEquals(emptyList<Pair<App, String>>(), SamsungSession.parseApps(null))
    }

    @Test fun `Samsung er en gyldig TV-type, og SSDP gjenkjenner bare TV-ens fjernkontrolltjeneste`() {
        assertEquals(Device("samsung", host, "Samsung-TV"), Validate.device("samsung", host, ""))
        assertEquals(Device("samsung", host, "Samsung-TV"), Ssdp.classify("ST: urn:samsung.com:device:RemoteControlReceiver:1", host))
        assertNull(Ssdp.classify("SERVER: Samsung Galaxy\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1", host))
        assertNull(Ssdp.classify("ST: urn:samsung.com:device:RemoteControlReceiver:1", "8.8.8.8"))
    }

    @Test fun `token lagres under eget navn ved siden av LG-nøkler`() {
        val dir = Files.createTempDirectory("fjern").toFile()
        val store = KeyStore(File(dir, "lg-keys.json"))
        store.update(host, key = "lg-nøkkel")
        store.update(SamsungSession.storeKey(host), token = "29384756", fingerprint = "SA:MS", mac = "a0:d0:5b:01:02:03")
        assertEquals(KeyStore.Entry(fingerprint = "SA:MS", mac = "a0:d0:5b:01:02:03", token = "29384756"), store.get(SamsungSession.storeKey(host)))
        assertEquals("lg-nøkkel", store.get(host)?.key)
        assertNull(store.get(host)?.token)
        store.remove(SamsungSession.storeKey(host))
        assertNull(store.get(SamsungSession.storeKey(host)))
        dir.deleteRecursively()
    }
}
