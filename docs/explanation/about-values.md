# About canonical values

Atlas formats values rather than numbers. `formatMoney` takes a money value, and there is no
overload taking an amount and a currency code as two arguments.

## A canonical value type

A canonical value type carries a quantity together with the facts a formatter needs to write it:
`money` is an exact amount and the currency it is in. That is why `formatMoney` takes a money value:
everything it has to know is in the one argument.

`formatMoney(19.99, 'USD')` is the shape that goes wrong quietly. A binary float cannot hold `19.99`,
so the amount formatted is not the amount meant, and the symptom shows up far from the call, as a
rounding discrepancy in a total.

`decimal` takes a string, because a string is what a database, an API and a form give you, and
passing it through unchanged preserves it.

The same reasoning runs through the rest. `measurement(decimal('3.5'), 'kilometer')` carries its
unit. `percent(decimal('0.15'))` carries its scale, so nothing has to guess whether `15` meant
fifteen percent or fifteen hundredths. `plainDate(2026, 3, 14)` is a date with no time and no zone,
which is what a birthday is, and it takes a calendar when the calendar is not the locale's own. A
zoned date-time carries its zone; a duration carries its units.

## One source per fact

The formatter's options are `Intl`'s own, minus the ones the value already decided. `formatMoney`
takes no `currency`, because the money value carries it. A currency passed beside a money value
would be a second source for one fact, and it is the one that goes stale.

## A result rather than an exception

A formatter returns a result. A success carries the formatted text, the parts behind it, and the
locale that produced it, so a template that styles the currency symbol differently from the amount
has the pieces rather than a string to pull apart. A failure carries a diagnostic with a code.

Formatting runs inside rendering, where a thrown error takes the view down with it. A code is also
what a catalog message can be keyed on, so the sentence a visitor reads about a bad value is content
you author.

## Parsing

Parsing is the same contract in the other direction. `LocalizedInput` gives a form the parsed value
rather than the text, and reports what it could not read with a stable code. The parse runs in the
committed locale, so a field respelled by a locale change reads back in the script it was respelled
into, and the amount that comes out is the amount that went in.

The control does not validate business rules. Whether an amount is within a limit, whether a date is
in the future, whether a quantity is in stock: those run on the parsed value, which is the reason for
parsing it first.

## Where a convention is set

`withFormattingContext` sets what every formatter starts from: the numbering system, the calendar,
the time zone, the currency display, and the rest of what a locale can be written more than one way
in. It is one setting for the application.

That is why the numbering system a locale is written in is declared where the locales are declared. An
application shipping `ar-EG` and `fa-IR` cannot say with a single application-wide value that one is
written in `arab` digits and the other in `arabext`.

## Relative time

"3 days ago" is two decisions: how far apart the two moments are, and which unit to say it in. The
distance is arithmetic. The unit is a product decision, so `withRelativeTimePolicy` sets the
thresholds and Atlas does not pick them: a support tool keeps saying minutes for longer than a news
feed does.

`withLocalizationClock` decides what `now` is. Left out, it is the system clock. `fixedClock` pins
it, which is what makes a relative time reproducible in a test.

## Person names

Order, which parts are used, and how they are shortened vary by the name's own language rather than
by the page's, so `personName` takes the language the name is in and formats with
[CLDR](https://cldr.unicode.org/)'s rules for it. That is what puts the surname first for a Japanese
name read on an English page.

## Related

- [How to format a value](../how-to/format-values.md)
- [How to read typed input](../how-to/read-typed-input.md)
- [Entry points](../reference/entry-points.md)
