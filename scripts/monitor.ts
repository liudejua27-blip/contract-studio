import {operationsReport} from '../src/server/operations';
import {closeDatabase} from '../src/server/db';
operationsReport().then(report=>{console.log(JSON.stringify(report));if(report.alerts.length)process.exitCode=2;}).catch(()=>{console.error('operations_monitor_unavailable');process.exitCode=1}).finally(closeDatabase);
