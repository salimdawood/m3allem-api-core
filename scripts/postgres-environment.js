// libpq does not expand a URI supplied through PGDATABASE's default value.
// Pass its parts as environment variables so credentials never enter argv.
export function postgresEnvironment(connection, base = process.env) {
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL connection URI required.');
  const result = { ...base, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '20' };
  for (const key of ['PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR', 'PGOPTIONS', 'PGSSLMODE', 'PGCHANNELBINDING']) delete result[key];
  const options = { sslmode: 'PGSSLMODE', channel_binding: 'PGCHANNELBINDING', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY', sslpassword: 'PGSSLPASSWORD', connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME', options: 'PGOPTIONS' };
  for (const [key, value] of url.searchParams) if (options[key]) result[options[key]] = value;
  return result;
}
