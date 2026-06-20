function log(level, evento, fields) {
    const entry = { ts: new Date().toISOString(), level, evento, ...fields };
    const line = JSON.stringify(entry) + '\n';
    if (level === 'error' || level === 'warn') {
        process.stderr.write(line);
    } else {
        process.stdout.write(line);
    }
}

module.exports = {
    info:  (evento, fields = {}) => log('info',  evento, fields),
    warn:  (evento, fields = {}) => log('warn',  evento, fields),
    error: (evento, fields = {}) => log('error', evento, fields),
    debug: (evento, fields = {}) => log('debug', evento, fields),
};
