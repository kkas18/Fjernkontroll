package no.fjern.app

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Selvsignert klientsertifikat (X.509 v3, RSA 2048, SHA-256), samme som lib/x509.mjs.
 * Android TV kjenner igjen appen på sertifikatet: hver installasjon lager sitt eget nøkkelpar.
 */
object X509 {
    class Identity(val certificate: X509Certificate, val privateKey: PrivateKey, val certDer: ByteArray, val keyDer: ByteArray)

    private fun length(n: Int): ByteArray {
        if (n < 0x80) return byteArrayOf(n.toByte())
        val bytes = mutableListOf<Byte>()
        var value = n
        while (value > 0) {
            bytes.add(0, (value and 0xff).toByte())
            value = value shr 8
        }
        return byteArrayOf((0x80 or bytes.size).toByte()) + bytes.toByteArray()
    }

    private fun tlv(tag: Int, vararg content: ByteArray): ByteArray {
        val body = ByteArrayOutputStream().also { out -> content.forEach { out.write(it) } }.toByteArray()
        return byteArrayOf(tag.toByte()) + length(body.size) + body
    }

    private fun sequence(vararg items: ByteArray) = tlv(0x30, *items)
    private fun set(vararg items: ByteArray) = tlv(0x31, *items)
    private fun integer(value: BigInteger) = tlv(0x02, value.toByteArray())

    private fun oid(dotted: String): ByteArray {
        val parts = dotted.split(".").map { it.toLong() }
        val out = ByteArrayOutputStream()
        out.write((40 * parts[0] + parts[1]).toInt())
        for (part in parts.drop(2)) {
            val chunk = mutableListOf<Int>()
            var value = part
            do {
                chunk.add(0, (value and 0x7f).toInt())
                value = value shr 7
            } while (value > 0)
            for (i in 0 until chunk.size - 1) chunk[i] = chunk[i] or 0x80
            chunk.forEach { out.write(it) }
        }
        return tlv(0x06, out.toByteArray())
    }

    /** UTCTime til og med 2049, GeneralizedTime etter (RFC 5280). */
    private fun time(date: Date): ByteArray {
        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = date }
        val utc = calendar.get(Calendar.YEAR) < 2050
        val format = SimpleDateFormat(if (utc) "yyMMddHHmmss'Z'" else "yyyyMMddHHmmss'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return tlv(if (utc) 0x17 else 0x18, format.format(date).toByteArray(Charsets.US_ASCII))
    }

    private val SHA256_WITH_RSA = sequence(oid("1.2.840.113549.1.1.11"), byteArrayOf(0x05, 0x00))
    private fun name(commonName: String) = sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, commonName.toByteArray(Charsets.UTF_8)))))

    fun create(commonName: String = "Fjern", years: Int = 20, now: Date = Date()): Identity {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048, SecureRandom()) }.generateKeyPair()
        val notBefore = Date(now.time - 24L * 3600 * 1000)
        val notAfter = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = now; add(Calendar.YEAR, years) }.time
        val serial = BigInteger(1, byteArrayOf(0x01) + ByteArray(15).also { SecureRandom().nextBytes(it) })
        val tbs = sequence(
            tlv(0xa0, integer(BigInteger.valueOf(2))), // versjon 3
            integer(serial),
            SHA256_WITH_RSA,
            name(commonName),
            sequence(time(notBefore), time(notAfter)),
            name(commonName),
            pair.public.encoded, // SubjectPublicKeyInfo
        )
        val signature = Signature.getInstance("SHA256withRSA").apply { initSign(pair.private); update(tbs) }.sign()
        val der = sequence(tbs, SHA256_WITH_RSA, tlv(0x03, byteArrayOf(0) + signature))
        return load(der, pair.private.encoded)
    }

    fun load(certDer: ByteArray, keyDer: ByteArray): Identity {
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(certDer.inputStream()) as X509Certificate
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyDer))
        return Identity(certificate, key, certDer, keyDer)
    }

    /** Modulus og eksponent som rå, store-endian byte uten fortegnsbyte (brukes i paringskoden). */
    fun rsaNumbers(key: PublicKey): Pair<ByteArray, ByteArray> {
        val rsa = key as? RSAPublicKey ?: throw UserError("Android TV-en bruker en ukjent nøkkeltype.", 502)
        fun unsigned(value: BigInteger): ByteArray = value.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
        return unsigned(rsa.modulus) to unsigned(rsa.publicExponent)
    }
}
