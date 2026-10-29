# Fiat amounts

This rule is binding for every stored amount, every response, and every review.
It wins over any sentence in this repository that writes a daily close, a later
spot, or a round trip through sats onto a committed amount.

The supported currencies are USD, CHF, EUR, and PHP. The rule is the same for
each of them. No currency is special.

## A committed amount keeps the figures fixed when it was created

A payment, charge, gift, loan, ask, repayment, or any other amount that already
exists keeps the fiat figures fixed at that moment. A later read returns those
figures. It does not compute new ones.

If a person types an amount in one currency, that exact decimal string is what
is stored and returned for that currency. Typing 5.00 stores 5.00. It is never
derived again from the sats. Converting those sats back through any rate,
including the rate used at that moment and including a stored daily close, can
round 5.00 to 4.99. That rounding is forbidden for the currency that was typed.

The other supported currencies are the amounts frozen at that same moment.
Later reads return those frozen strings. They do not recompute them.

A missing frozen string stays missing. It is JSON `null`. It is not filled from
the current spot, and it is not filled later from a daily close, a migration,
or another row. The amount remains without that currency.

## A till charge returns the typed figure to the shop and to the payer

The shop operator types the till amount. When that amount is typed in one
currency, that exact decimal string is stored on the charge when the charge
is created. The shop's till read and the payer's read of that same charge
both return that string. The payer pays in bitcoin. That payment does not
change the string.

Typing 12.00 pesos stores 12.00. Both sides receive 12.00 and both show
12.00. Neither side receives or shows 12.01 or 11.99. The same holds when
the typed currency is the dollar, the franc, or the euro. No currency is
special.

Neither side derives that string from the sats, from the rate that turned the
typed digits into sats, from a later spot, or from a daily close. The payer's
own display currency does not replace it. The string stays on the open
charge, on the paid charge, and on the history both sides keep of that
payment. A response that carries only the sat count, so either side prices
those sats, breaks this rule.

## What may use the rate of now

The current spot, served for what a holding is worth right now, is not a
committed amount.

While a person is still typing, the current spot may turn those digits into
sats for the payment that is about to be created. The figure stored for the
currency they typed is the figure they typed, not the sats converted back.

## Daily rates

`btc_usd_daily` and `usd_fiat_daily` are the market's daily closes. They are
not the amount of a payment. A payment does not read them to replace, fill, or
correct its own fiat figures.
