#!/bin/bash

ISOLATED_SERVER_PATH="/home/ina/Projects/zilliqa-isolated-server"
cd $ISOLATED_SERVER_PATH
docker rm -f isolated-server
docker run -d -p 5555:5555   --name isolated-server   isolated-server:1.0
docker container ls
cd -

# make sure the isolated server is ready
sleep 3

echo "Deploying ZRC6"
ZRC6_FILE="zrc6_rialto_v0.1.scilla"
INIT_FILE="init/init-zrc6.json"
ret=`zli contract deploy -c $ZRC6_FILE -i $INIT_FILE  -p 2000000000 -l 40000`
zrc6_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $zrc6_addr

TOOL_PATH="./"
cd $TOOL_PATH
batch_size=100
node contract.js batchmint $zrc6_addr 1 $batch_size
cd -

echo "Deploying collection contract"
COLLECTION_FILE="../../contracts/collection.scilla"
COLLECTION_INIT="init/init-collection.json"
ret=`zli contract deploy -c $COLLECTION_FILE -i $COLLECTION_INIT  -p 2000000000 -l 40000`
collection_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $collection_addr

echo "Deploying fixed price"
FP_FILE="../../contracts/fixed_price_signed.scilla"
FP_INIT="init/init-fp.json"
echo "Updating fixed price contract init file"
sed -i "15s/.*/\"value\" : \"$collection_addr\"/" $FP_INIT
ret=`zli contract deploy -c $FP_FILE -i $FP_INIT  -p 2000000000 -l 40000`
fp_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $fp_addr

echo "Setting the verifier pub key"
PUBKEY="0x03d3c94c377f0fb329dc5c857f7dbd7f694eecfca377db079b68ef7285905baa0b"
node contract.js regpubkey $fp_addr $PUBKEY

echo "Sell Order Side"
SELL_SIDE=0
BUY_SIDE=1
SELLER_WALLET="seller"
BUYER_WALLET="buyer"
token_id=99
cd $TOOL_PATH
node contract.js setspender $zrc6_addr $token_id $fp_addr
node contract.js setorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $SELLER_WALLET
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $BUYER_WALLET
cd -

echo "Buy Order Side"
token_id=80
cd $TOOL_PATH
node contract.js setspender $zrc6_addr $token_id $fp_addr
node contract.js setorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $SELLER_WALLET
node contract.js setorder $fp_addr $zrc6_addr $token_id $BUY_SIDE $BUYER_WALLET
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $BUY_SIDE $SELLER_WALLET
cd -



echo "Contracts"
echo "zrc6=$zrc6_addr"
echo "collection=$collection_addr"
echo "fp=$fp_addr"
