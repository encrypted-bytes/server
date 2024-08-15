pnpm i
mkdir temp
mkdir files
cat .env.example > .env
echo "$(cat .env).$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)" > .env