package no.fjern.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.nio.file.Files
import java.security.MessageDigest
import java.security.interfaces.RSAPublicKey

/** Samme regler som tests/androidtv.test.mjs for Node-broen. */
class AndroidTvLogicTest {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    @Test fun protobufVarintFieldsAndFrames() {
        listOf(0L, 1L, 127L, 128L, 300L, 622L, Int.MAX_VALUE.toLong(), -1L).forEach { assertEquals(it, Proto.readVarint(Proto.varint(it))?.first) }
        assertNull(Proto.readVarint(byteArrayOf(0x80.toByte())))
        // Samme bytes som Node-versjonen (tests/androidtv.test.mjs).
        assertEquals("080210c80152120a0961747672656d6f74651205466a65726e", hex(AndroidTvSession.pairingRequest()))
        val fields = Proto.decode(AndroidTvSession.pairingRequest())
        assertEquals(200L, fields.long(2))
        assertEquals("Fjern", fields.message(10)?.text(2))
        val got = mutableListOf<String>()
        val reader = Proto.FrameReader { got += String(it) }
        val stream = Proto.frame("hei".toByteArray()) + Proto.frame("på deg".toByteArray())
        reader.feed(stream.copyOfRange(0, 2))
        reader.feed(stream.copyOfRange(2, stream.size))
        assertEquals(listOf("hei", "på deg"), got)
        try { Proto.FrameReader(max = 4) {}.feed(Proto.frame(ByteArray(10))); throw AssertionError("forventet feil") } catch (_: IllegalArgumentException) {}
    }

    @Test fun selfSignedCertificateIsValid() {
        val identity = X509.create("Fjern")
        val cert = identity.certificate
        cert.verify(cert.publicKey)
        cert.checkValidity()
        assertEquals(3, cert.version)
        assertEquals("CN=Fjern", cert.subjectX500Principal.name)
        assertEquals(2048, (cert.publicKey as RSAPublicKey).modulus.bitLength())
        assertTrue(cert.notAfter.time > System.currentTimeMillis() + 19L * 365 * 24 * 3600 * 1000)
        val (modulus, exponent) = X509.rsaNumbers(cert.publicKey)
        assertEquals(256, modulus.size)
        assertEquals("010001", hex(exponent))
    }

    @Test fun identityIsStoredAndReused() {
        val dir = Files.createTempDirectory("fjern").toFile()
        val file = File(dir, "androidtv-client.json")
        val first = AndroidTvSession.loadOrCreateIdentity(file)
        val again = AndroidTvSession.loadOrCreateIdentity(file)
        assertArrayEquals(first.certDer, again.certDer)
        dir.deleteRecursively()
    }

    @Test fun pairingCodeIsCheckedLocally() {
        val client = X509.create("Fjern").certificate.publicKey as RSAPublicKey
        val server = X509.create("tv").certificate.publicKey as RSAPublicKey
        // Uavhengig utregning: SHA-256 over modulus/eksponent (uten fortegnsbyte) og de to siste kodebytene.
        fun raw(value: BigInteger) = value.toByteArray().let { if (it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
        val nonce = byteArrayOf(0x3c, 0x7f)
        val hash = MessageDigest.getInstance("SHA-256").digest(ByteArrayOutputStream().apply {
            write(raw(client.modulus)); write(raw(client.publicExponent)); write(raw(server.modulus)); write(raw(server.publicExponent)); write(nonce)
        }.toByteArray())
        val code = hex(byteArrayOf(hash[0]) + nonce).uppercase()
        assertArrayEquals(hash, AndroidTvSession.pairingSecret(client, server, code.lowercase()))
        val wrong = "%02X".format((hash[0].toInt() + 1) and 0xff) + code.substring(2)
        assertNull(AndroidTvSession.pairingSecret(client, server, wrong))
        listOf("12345", "GHIJKL", "").forEach {
            try { AndroidTvSession.pairingSecret(client, server, it); throw AssertionError(it) } catch (_: UserError) {}
        }
    }

    @Test fun keysAppsAndValidation() {
        AndroidTvSession.EXTRA_KEYS.forEach { assertTrue(it, AndroidTvSession.KEYS.containsKey(it)) }
        AndroidTvSession.KEYS.keys.forEach { assertTrue(it, it in Validate.COMMANDS) }
        assertEquals(7, AndroidTvSession.KEYS["Num0"])
        assertEquals(186, AndroidTvSession.KEYS["Blue"])
        assertEquals(Device("androidtv", "192.168.1.60", "Android TV"), Validate.device("androidtv", "192.168.1.60", ""))
        val key = Proto.decode(AndroidTvSession.remoteKey(19)).message(10)
        assertEquals(19L, key?.long(1))
        assertEquals(3L, key?.long(2))
        assertEquals("https://www.youtube.com", Proto.decode(AndroidTvSession.remoteAppLink("https://www.youtube.com")).message(90)?.text(1))
    }

    private fun repoFile(relative: String): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null && !File(dir, relative).exists()) dir = dir.parentFile
        return File(dir ?: throw AssertionError("fant ikke $relative"), relative)
    }

    /**
     * Regresjon: https-applenker startet ingenting på Telia-boksen. Appene åpnes med pakkenavn via Play-butikken,
     * listen er den samme som i Node-broen, og hvert ikon finnes i public/icons/apps/.
     */
    @Test fun appsLaunchByPackageAndMatchTheNodeBridge() {
        val node = repoFile("lib/androidtv.mjs").readText()
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        assertTrue(AndroidTvSession.APPS.any { it.id == "teliaplay" && it.pkg == "no.get.play.tv" })
        assertEquals(AndroidTvSession.APPS.size, AndroidTvSession.APPS.map { it.id }.toSet().size)
        AndroidTvSession.APPS.forEach { app ->
            Validate.appId(app.id)
            assertEquals("market://launch?id=${app.pkg}", app.link)
            assertTrue("${app.id} mangler i lib/androidtv.mjs", node.contains("{ id: '${app.id}', name: '${app.name}', package: '${app.pkg}' }"))
            val icon = repoFile("public${app.icon}")
            assertArrayEquals(png, icon.readBytes().copyOfRange(0, 4))
        }
        assertEquals(AndroidTvSession.APPS.size, Regex("package: '").findAll(node).count())
    }

    @Test fun featuresAreIntersectedWithTheBox() {
        assertEquals(615, AndroidTvSession.FEATURES)
        assertEquals(614, AndroidTvSession.activeFeatures(622))
        assertEquals(6, AndroidTvSession.activeFeatures(6))
        assertEquals(615, AndroidTvSession.activeFeatures(0))
        assertEquals(614L, Proto.decode(AndroidTvSession.remoteConfigure(614)).message(1)?.long(1))
        assertEquals(6L, Proto.decode(AndroidTvSession.remoteSetActive(6)).message(2)?.long(1))
    }

    /**
     * Regresjon: ruten «pair» manglet i NativeBridge, så paringskoden aldri nådde boksen i Android-appen.
     * Alle ruter grensesnittet kaller (api('…') og route: '…'), må være tillatt.
     */
    @Test fun everyRouteTheUiCallsIsAllowedInTheApp() {
        val source = repoFile("public/app.js").readText()
        val used = (Regex("api\\('([a-z]+)'").findAll(source) + Regex("route: '([a-z]+)'").findAll(source)).map { it.groupValues[1] }.toSet() + "connect"
        assertTrue("for få ruter funnet: $used", used.size >= 10)
        used.forEach { assertTrue("ruten «$it» er ikke tillatt i Bridge.ROUTES", it in Bridge.ROUTES) }
        assertTrue("pair" in used)
    }

    @Test fun mdnsQueryAndCompressedResponse() {
        val query = Mdns.query()
        assertEquals(Mdns.SERVICE, Mdns.readName(query, 12).first)
        // Svar med PTR-post der instansnavnet peker tilbake til tjenestenavnet (komprimering).
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0, 0, 0x84.toByte(), 0, 0, 0, 0, 1, 0, 0, 0, 0))
        Mdns.SERVICE.split(".").forEach { out.write(it.length); out.write(it.toByteArray()) }
        out.write(0)
        val label = "Telia Play-boks".toByteArray()
        val rdata = byteArrayOf(label.size.toByte()) + label + byteArrayOf(0xc0.toByte(), 12)
        out.write(byteArrayOf(0, 12, 0, 1, 0, 0, 0, 120, 0, rdata.size.toByte()))
        out.write(rdata)
        assertEquals(listOf("Telia Play-boks"), Mdns.parseResponse(out.toByteArray()))
        assertEquals(emptyList<String>(), Mdns.parseResponse(ByteArray(5)))
        try { Mdns.readName(ByteArray(12) + byteArrayOf(0xc0.toByte(), 12), 12); throw AssertionError("forventet feil") } catch (_: IllegalArgumentException) {}
    }
}
