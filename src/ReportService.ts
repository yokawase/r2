import SpreadAnalyzer from './SpreadAnalyzer';
import { injectable, inject } from 'inversify';
import symbols from './symbols';
import { SpreadStatTimeSeries, Quote, ConfigStore } from './types';
import QuoteAggregator from './QuoteAggregator';
import { spreadStatToCsv, spreadStatCsvHeader } from './SpreadStatTimeSeries';
import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import { promisify } from 'util';
import { fork, ChildProcess } from 'child_process';
import { reportServicePubUrl, reportServiceRepUrl } from './constants';
import { getLogger } from '@bitr/logger';
import { cwd } from './util';
import { Duration, DateTime } from 'luxon';
import { SnapshotResponder } from './messages';
import { ZmqPublisher } from '@bitr/zmq';

const writeFile = promisify(fs.writeFile);

@injectable()
export default class ReportService {
  private readonly log = getLogger(this.constructor.name);
  private readonly analyticsPath = `${__dirname}/analytics`;
  private readonly reportDir = `${cwd()}/reports`;
  private readonly spreadStatReport = `${this.reportDir}/spreadStat.csv`;
  private spreadStatWriteStream: fs.WriteStream;
  private streamPublisher: ZmqPublisher;
  private snapshotResponder: SnapshotResponder;
  private analyticsProcess: ChildProcess;
  private handlerRef: (quotes: Quote[]) => Promise<void>;

  constructor(
    private readonly quoteAggregator: QuoteAggregator,
    private readonly spreadAnalyzer: SpreadAnalyzer,
    @inject(symbols.SpreadStatTimeSeries) private readonly spreadStatTimeSeries: SpreadStatTimeSeries,
    @inject(symbols.ConfigStore) private readonly configStore: ConfigStore
  ) {}

  async start() {
    this.log.debug('Starting ReportService...');
    mkdirp.sync(this.reportDir);
    if (!fs.existsSync(this.spreadStatReport)) {
      await writeFile(this.spreadStatReport, spreadStatCsvHeader, { flag: 'a' });
    }
    this.spreadStatWriteStream = fs.createWriteStream(this.spreadStatReport, { flags: 'a' });
    this.handlerRef = this.quoteUpdated.bind(this);
    this.quoteAggregator.on('quoteUpdated', this.handlerRef);
    const { analytics } = this.configStore.config;
    if (analytics && analytics.enabled) {
      const duration = Duration.fromObject(analytics.initialHistory);
      const dt = DateTime.local();
      const start = dt.minus(duration).toJSDate();
      const end = dt.toJSDate();
      const snapshot = await this.spreadStatTimeSeries.query({ start, end });
      this.snapshotResponder = new SnapshotResponder(reportServiceRepUrl, (request, respond) => {
        if (request && request.type === 'spreadStatSnapshot') {
          respond({ success: true, data: snapshot.map(s => s.value) });
        } else {
          respond({ success: false, reason: 'invalid request' });
        }
      });
      this.streamPublisher = new ZmqPublisher(reportServicePubUrl);
      this.analyticsProcess = fork(this.analyticsPath, [], { stdio: [0, 1, 2, 'ipc'] });
    }
    this.log.debug('Started.');
  }

  async stop() {
    this.log.debug('Stopping ReportService...');
    this.quoteAggregator.removeListener('quoteUpdated', this.handlerRef)
    this.spreadStatWriteStream.close();
    if (this.analyticsProcess) {
      await promisify(this.analyticsProcess.send).bind(this.analyticsProcess)('stop');
      this.analyticsProcess.kill();
      this.streamPublisher.dispose();
      this.snapshotResponder.dispose();
    }
    this.log.debug('Stopped.');
  }

  private async quoteUpdated(quotes: Quote[]): Promise<void> {
    const stat = await this.spreadAnalyzer.getSpreadStat(quotes);
    if (stat) {
      await this.spreadStatTimeSeries.put(stat);
      await promisify(this.spreadStatWriteStream.write).bind(this.spreadStatWriteStream)(spreadStatToCsv(stat));
      const { analytics } = this.configStore.config;
      if (analytics && analytics.enabled && this.analyticsProcess.connected) {
        this.streamPublisher.publish('spreadStat', stat);
      }
    }
  }
} /* istanbul ignore next */
