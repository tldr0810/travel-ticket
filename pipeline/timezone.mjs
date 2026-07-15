// Pure timezone calculations shared by the LLM pipeline and MCP mechanical tools.
export const tzOffsetMinutes = (timeZone, atIso) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(atIso))
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const match = raw.match(/GMT([+-])(\d{2}):(\d{2})/)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

export const localToUtc = (date, time, timeZone) => {
  let guess = Date.parse(`${date}T${time}:00Z`)
  for (let index = 0; index < 2; index++) {
    guess = Date.parse(`${date}T${time}:00Z`) - tzOffsetMinutes(timeZone, new Date(guess).toISOString()) * 60_000
  }
  return new Date(guess).toISOString().replace('.000Z', 'Z')
}

const fmtOffset = (minutes) => {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export function runTimezoneAgent(brief) {
  const { home_timezone: htz, destination_timezone: dtz, start_date, end_date } = brief
  const startIso = `${start_date}T12:00:00Z`
  const endIso = `${end_date}T12:00:00Z`
  const offsets = {
    destination_start: tzOffsetMinutes(dtz, startIso), destination_end: tzOffsetMinutes(dtz, endIso),
    home_start: tzOffsetMinutes(htz, startIso), home_end: tzOffsetMinutes(htz, endIso),
  }
  const dstChange = offsets.destination_start !== offsets.destination_end || offsets.home_start !== offsets.home_end
  const diffHours = (offsets.destination_start - offsets.home_start) / 60
  const ahead = diffHours >= 0
  const rule = diffHours === 0
    ? 'Destination shares the home timezone in this period.'
    : `Destination is ${Math.abs(diffHours)} hour(s) ${ahead ? 'ahead of' : 'behind'} home in this period. ${ahead ? 'Subtract' : 'Add'} ${Math.abs(diffHours)} hour(s) from local time to get body-clock time.`
  return {
    home_timezone: htz, destination_timezone: dtz, destination_offset: fmtOffset(offsets.destination_start), home_offset: fmtOffset(offsets.home_start),
    diff_hours: diffHours, dst_change_during_trip: dstChange, body_clock_rule: dstChange ? `${rule} Note: a DST change occurs during the trip window.` : rule,
  }
}
