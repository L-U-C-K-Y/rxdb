import assert from 'assert';
import AsyncTestUtil, {
    clone,
    wait,
    waitUntil
} from 'async-test-util';
import config from './config';
import * as schemaObjects from '../helper/schema-objects';
import * as schemas from '../helper/schemas';
import * as humansCollection from '../helper/humans-collection';
import {
    startWebsocketServer,
    replicateWithWebsocketServer
} from '../../plugins/replication-websocket';
import {
    randomCouchString,
    RxCollection
} from '../../';
import { getPort } from '../helper/graphql-server';

config.parallel('replication-websocket.test.ts', () => {

    type TestDocType = schemaObjects.HumanWithTimestampDocumentType;
    async function getTestCollections(docsAmount: { local: number, remote: number }): Promise<{
        localCollection: RxCollection<TestDocType, {}, {}, {}>,
        remoteCollection: RxCollection<TestDocType, {}, {}, {}>
    }> {

        const collectionName = 'col' + randomCouchString(10);
        const [localCollection, remoteCollection] = await Promise.all([
            humansCollection.createHumanWithTimestamp(docsAmount.local, collectionName, false),
            humansCollection.createHumanWithTimestamp(docsAmount.remote, collectionName, false)
        ]);
        return {
            localCollection,
            remoteCollection
        };
    }

    function getPortAndUrl(path?: string) {
        const port = getPort();
        let url = 'ws://localhost:' + port;
        if (path) {
            url += '/' + path;
        }
        return {
            port,
            url
        };
    }

    it('should start a server+client and replicate one document from server to the client', async () => {
        const { localCollection, remoteCollection } = await getTestCollections({
            local: 1,
            remote: 1
        });

        const portAndUrl = getPortAndUrl();

        await startWebsocketServer({
            database: remoteCollection.database,
            port: portAndUrl.port
        });

        const replicationState = await replicateWithWebsocketServer({
            collection: localCollection,
            url: portAndUrl.url
        });
        replicationState.error$.subscribe(err => {
            console.log('got error :');
            console.log(JSON.stringify(err, null, 4));
            throw err;
        });


        await replicationState.awaitInSync();

        const serverDocs = await remoteCollection.find().exec();
        assert.strictEqual(serverDocs.length, 2);
        const clientDocs = await localCollection.find().exec();
        assert.strictEqual(clientDocs.length, 2);

        localCollection.database.destroy();
        remoteCollection.database.destroy();
    });
    it('should replicate ongoing writes', async () => {
        const { localCollection, remoteCollection } = await getTestCollections({
            local: 1,
            remote: 1
        });

        const clientDoc = await localCollection.findOne().exec(true);
        const serverDoc = await remoteCollection.findOne().exec(true);

        const portAndUrl = getPortAndUrl();

        await startWebsocketServer({
            database: remoteCollection.database,
            port: portAndUrl.port
        });

        const replicationState = await replicateWithWebsocketServer({
            collection: localCollection,
            url: portAndUrl.url
        });
        replicationState.error$.subscribe(err => {
            console.log('got error :');
            console.log(JSON.stringify(err, null, 4));
            throw err;
        });
        await replicationState.awaitInSync();


        // UPDATE
        await clientDoc.atomicPatch({
            name: 'client-edited'
        });
        await serverDoc.atomicPatch({
            name: 'server-edited'
        });

        await replicationState.awaitInSync();

        const clientDocOnServer = await remoteCollection.findOne(clientDoc.primary).exec(true);
        assert.strictEqual(clientDocOnServer.name, 'client-edited');

        const serverDocOnClient = await localCollection.findOne(serverDoc.primary).exec(true);
        assert.strictEqual(serverDocOnClient.name, 'server-edited');


        // DELETE
        await serverDoc.remove();
        await clientDoc.remove();
        await replicationState.awaitInSync();
        const deletedServer = await remoteCollection.findOne().exec();
        const deletedClient = await localCollection.findOne().exec();
        assert.ok(!deletedServer);
        assert.ok(!deletedClient);

        localCollection.database.destroy();
        remoteCollection.database.destroy();
    });
    it('should continue the replication when the connection is broken and established again', async () => {
        const { localCollection, remoteCollection } = await getTestCollections({
            local: 1,
            remote: 1
        });

        const clientDoc = await localCollection.findOne().exec(true);
        const serverDoc = await remoteCollection.findOne().exec(true);

        const portAndUrl = getPortAndUrl();

        const serverState = await startWebsocketServer({
            database: remoteCollection.database,
            port: portAndUrl.port
        });

        const replicationState = await replicateWithWebsocketServer({
            collection: localCollection,
            url: portAndUrl.url
        });
        replicationState.error$.subscribe(err => {
            console.log('got error :');
            console.log(JSON.stringify(err, null, 4));
            throw err;
        });

        await replicationState.awaitInSync();
        const serverDocs = await remoteCollection.find().exec();
        assert.strictEqual(serverDocs.length, 2);


        // go 'offline'
        console.log('#### go OFFLINE');
        await serverState.close();
        console.log('#### go OFFLINE DONE');

        // modify on both sides while offline
        await clientDoc.atomicPatch({
            name: 'client-edited'
        });
        await serverDoc.atomicPatch({
            name: 'server-edited'
        });
        await wait(100);

        // go 'online' again
        console.log('########## got ONLINE again');
        const serverState2 = await startWebsocketServer({
            database: remoteCollection.database,
            port: portAndUrl.port
        });

        console.log('### await in sync');
        await replicationState.awaitInSync();
        console.log('### await in sync DONE');
        const clientDocOnServer = await remoteCollection.findOne(clientDoc.primary).exec(true);
        assert.strictEqual(clientDocOnServer.name, 'client-edited');
        const serverDocOnClient = await localCollection.findOne(serverDoc.primary).exec(true);
        assert.strictEqual(serverDocOnClient.name, 'server-edited');


        process.exit();

        localCollection.database.destroy();
        remoteCollection.database.destroy();
    });
});
