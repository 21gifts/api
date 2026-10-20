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
