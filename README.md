# Grupo-E — Sistema de Gestão de Clientes

Sistema web completo para gestão de atendimentos, clientes e pesquisas de satisfação.

## Stack

- **Backend**: Node.js 22 + Express + SQLite (nativo do Node.js 22, zero drivers)
- **Auth**: JWT (access token 15min) + Refresh token rotativo (30 dias) em cookies HttpOnly
- **Frontend**: HTML/CSS/JS puro (sem framework de build)
- **Segurança**: Helmet, CORS restrito, rate limiting, bcrypt (12 rounds), tokens rotativos
- **Keep-alive**: Auto-ping a cada 14min para evitar que o Render free-tier adormeça

---

## Rodando localmente

```bash
# 1. Clone / extraia o projeto
cd grupo-e-sistema

# 2. Instale dependências
npm install

# 3. Configure variáveis de ambiente
cp .env.example .env
# Edite .env com seus valores

# 4. Inicie
npm start
# Acesse: http://localhost:3000
```

**Usuário padrão criado automaticamente na primeira execução:**
- E-mail: `admin@grupoe.com.br`
- Senha: `Admin@2024!`
- ⚠️ Troque a senha imediatamente após o primeiro login.

---

## Deploy no Render (gratuito, sem dormir)

### Passo 1 — GitHub
1. Crie um repositório no GitHub
2. Faça push de todos os arquivos:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/SEU_USUARIO/grupo-e-sistema.git
   git push -u origin main
   ```

### Passo 2 — Render
1. Acesse [render.com](https://render.com) → **New Web Service**
2. Conecte o repositório GitHub
3. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `node server/index.js`
   - **Node Version**: `22` (em Environment → Node Version)
4. Adicione as variáveis de ambiente (**Environment** tab):
   ```
   NODE_ENV=production
   JWT_SECRET=<gere com: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
   JWT_REFRESH_SECRET=<gere outro segredo diferente>
   APP_URL=https://SEU-APP.onrender.com
   ALLOWED_ORIGINS=https://SEU-APP.onrender.com
   ```
5. Clique em **Deploy**

### Passo 3 — Após deploy
- Acesse a URL do Render
- Faça login com `admin@grupoe.com.br` / `Admin@2024!`
- **Crie um novo usuário administrador com email e senha fortes**
- **Exclua ou altere a senha do usuário padrão**

### Persistência de dados no Render Free
O banco `data/grupoe.db` é armazenado no disco efêmero do Render (resetado a cada deploy). Para persistência permanente:
- Use **Render Disk** (add-on pago, $1/mês) — monte em `/data`
- Ou migre para **PostgreSQL** (Render oferece free tier com 1GB)

---

## Segurança implementada

| Item | Implementação |
|------|--------------|
| Senhas | bcrypt com 12 rounds |
| Tokens | JWT + Refresh token rotativo (one-time-use) |
| Cookies | HttpOnly, SameSite=Strict, Secure em produção |
| CORS | Lista de origens explícita |
| Headers | Helmet (CSP, HSTS, X-Frame-Options…) |
| Rate limit | 10 tentativas de login/15min por IP; 200 req/min global |
| SQL injection | Queries parametrizadas (prepared statements) |
| Admin routes | Middleware de role verificando JWT em cada request |
| Token revogação | Logout invalida refresh token no banco |

---

## Estrutura de arquivos

```
grupo-e-sistema/
├── server/
│   ├── index.js          ← entry point Express
│   ├── db.js             ← SQLite (Node.js 22 nativo)
│   ├── auth.js           ← JWT, bcrypt, cookies
│   └── routes/
│       ├── auth.js       ← login, register, refresh, logout, me
│       ├── data.js       ← todos os módulos + dashboard + clear
│       └── users.js      ← CRUD de usuários (admin only)
├── public/
│   ├── index.html        ← SPA shell
│   ├── css/app.css       ← estilos completos
│   └── js/app.js         ← lógica frontend (módulos, auth, forms, dashboard)
├── data/                 ← banco SQLite (criado automaticamente)
├── .env.example
├── .gitignore
├── render.yaml
└── package.json
```

---

## Google OAuth (opcional)

Para ativar o login com Google real:

1. Crie credenciais OAuth 2.0 em [console.cloud.google.com](https://console.cloud.google.com)
2. Authorized redirect URI: `https://SEU-APP.onrender.com/api/auth/google/callback`
3. Adicione ao `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_CALLBACK_URL=https://SEU-APP.onrender.com/api/auth/google/callback
   ```
4. Instale `passport` + `passport-google-oauth20` e adicione rota OAuth no servidor

---

## Requisitos de Node.js

Node.js **22+** obrigatório (usa `node:sqlite` nativo, disponível desde Node 22.5).
No Render, configure em: **Settings → Environment → Node Version → 22**.
