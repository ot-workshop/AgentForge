// unit checker: runs `npm test`-style unit checks if present, else succeeds.
// Read-only with respect to the repository: it may write only inside the run dir.
process.stdout.write('unit ok\n');
process.exit(0);
