package no.fjern.app

import org.json.JSONException
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException

/** Feil som er ment for brukeren. Alt annet oversettes til en generell norsk melding. */
/**
 * Kaster ekte avbrytelser videre (coroutine avbrutt), men lar våre egne tidsavbrudd
 * (withTimeout) håndteres som vanlige feil. Brukes først i catch-blokker i suspend-kode.
 */
fun Throwable.rethrowCancellation() {
    if (this is kotlinx.coroutines.CancellationException && this !is kotlinx.coroutines.TimeoutCancellationException) throw this
}

class UserError(message: String, val status: Int = 400) : Exception(message)

data class UserMessage(val status: Int, val message: String, val internal: Boolean)

fun toUserMessage(error: Throwable): UserMessage = when (error) {
    is UserError -> UserMessage(error.status, error.message ?: "Feil.", false)
    is SocketTimeoutException, is kotlinx.coroutines.TimeoutCancellationException ->
        UserMessage(504, "TV-en svarte ikke i tide. Sjekk at den er på og på samme Wi‑Fi.", false)
    is JSONException -> UserMessage(400, "Ugyldig forespørsel.", false)
    is ConnectException, is NoRouteToHostException, is IOException ->
        UserMessage(502, "Fikk ikke kontakt med TV-en. Sjekk IP-adressen og nettverket.", false)
    else -> UserMessage(500, "Noe gikk galt. Prøv igjen.", true)
}
