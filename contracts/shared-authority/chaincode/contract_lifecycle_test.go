package main

import (
	"encoding/json"
	"fmt"
	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"testing"
)

// These tests exercise committed state transitions, not Fabric MVCC or endorsement.
type stateStub struct {
	shim.ChaincodeStubInterface
	state map[string][]byte
	tx    string
}

func (s *stateStub) GetState(key string) ([]byte, error) { return s.state[key], nil }
func (s *stateStub) PutState(key string, value []byte) error {
	s.state[key] = append([]byte(nil), value...)
	return nil
}
func (s *stateStub) GetTxID() string { return s.tx }

type testIdentity struct {
	cid.ClientIdentity
	msp, id string
}

func (i *testIdentity) GetMSPID() (string, error) { return i.msp, nil }
func (i *testIdentity) GetID() (string, error)    { return i.id, nil }

func lifecycleFixture(t *testing.T) (*SharedAuthorityContract, *contractapi.TransactionContext, *stateStub) {
	t.Helper()
	s := &stateStub{state: map[string][]byte{}, tx: "tx-initial"}
	ctx := &contractapi.TransactionContext{}
	ctx.SetStub(s)
	ctx.SetClientIdentity(&testIdentity{msp: "Org1MSP", id: "executor"})
	m := Mandate{MandateID: "mandate", Status: active, OwnerMSP: "Org1MSP", OwnerIdentity: "owner", Currency: "INR", AggregateCapPaise: 500000, ReservedPaise: 279900, ActiveUsageCount: 1,
		ParticipantIdentities: []callerIdentity{{MSPID: "Org1MSP", ClientID: "executor"}}, VerifierIdentities: []callerIdentity{{MSPID: "VerifierMSP", ClientID: "verifier"}}}
	r := Reservation{MandateID: "mandate", ReservationID: "reservation", AmountPaise: 279900, Currency: "INR", Status: reserved, ParticipantMSP: "Org1MSP", ExecutorIdentity: "executor"}
	for key, value := range map[string]any{mandateKey("mandate"): m, reservationKey("mandate", "reservation"): r} {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		s.state[key] = data
	}
	return &SharedAuthorityContract{}, ctx, s
}

func TestDispatchUnknownSettlementLifecycle(t *testing.T) {
	c, ctx, stub := lifecycleFixture(t)
	stub.tx = "dispatch-tx"
	r, err := c.BeginDispatch(ctx, "mandate", "reservation")
	if err != nil || r.Status != dispatching || r.DispatchTransactionID != stub.tx {
		t.Fatalf("dispatch: %+v %v", r, err)
	}
	if _, err = c.BeginDispatch(ctx, "mandate", "reservation"); err == nil {
		t.Fatal("duplicate dispatch claim accepted")
	}
	stub.tx = "unknown-tx"
	r, err = c.MarkUnknown(ctx, "mandate", "reservation")
	if err != nil || r.Status != unknown {
		t.Fatalf("unknown: %+v %v", r, err)
	}
	stub.tx = "retry-unknown"
	r, err = c.MarkUnknown(ctx, "mandate", "reservation")
	if err != nil || r.UnknownTransactionID != "unknown-tx" {
		t.Fatal("unknown retry changed original transaction")
	}
	m, err := c.QueryMandate(ctx, "mandate")
	if err != nil || m.ReservedPaise != 279900 || m.SettledPaise != 0 {
		t.Fatalf("unknown hold: %+v %v", m, err)
	}
	evidence := fmt.Sprintf("%064x", 1)
	if _, err = c.CommitOutcome(ctx, "mandate", "reservation", evidence); err == nil {
		t.Fatal("executor confirmed its own payment")
	}
	if _, err = c.ReleaseDefinitiveFailure(ctx, "mandate", "reservation", evidence); err == nil {
		t.Fatal("executor released uncertain payment")
	}
	ctx.SetClientIdentity(&testIdentity{msp: "VerifierMSP", id: "verifier"})
	stub.tx = "settlement-tx"
	r, err = c.CommitOutcome(ctx, "mandate", "reservation", evidence)
	if err != nil || r.Status != settled || r.OutcomeTransactionID != stub.tx {
		t.Fatalf("settlement: %+v %v", r, err)
	}
	stub.tx = "retry-settlement"
	r, err = c.CommitOutcome(ctx, "mandate", "reservation", evidence)
	if err != nil || r.OutcomeTransactionID != "settlement-tx" {
		t.Fatal("settlement retry changed original transition")
	}
	m, err = c.QueryMandate(ctx, "mandate")
	if err != nil || m.ReservedPaise != 0 || m.SettledPaise != 279900 || m.ActiveUsageCount != 1 {
		t.Fatalf("settled counters: %+v %v", m, err)
	}
	if _, err = c.CommitOutcome(ctx, "mandate", "reservation", fmt.Sprintf("%064x", 2)); err == nil {
		t.Fatal("settled evidence replaced")
	}
	if _, err = c.ReleaseDefinitiveFailure(ctx, "mandate", "reservation", evidence); err == nil {
		t.Fatal("settled payment released")
	}
}

func TestDefinitiveFailureReleasesExactlyOnce(t *testing.T) {
	for _, status := range []string{reserved, dispatching, unknown} {
		t.Run(status, func(t *testing.T) {
			c, ctx, stub := lifecycleFixture(t)
			if status != reserved {
				if _, err := c.BeginDispatch(ctx, "mandate", "reservation"); err != nil {
					t.Fatal(err)
				}
			}
			if status == unknown {
				if _, err := c.MarkUnknown(ctx, "mandate", "reservation"); err != nil {
					t.Fatal(err)
				}
			}
			ctx.SetClientIdentity(&testIdentity{msp: "VerifierMSP", id: "verifier"})
			evidence := fmt.Sprintf("%064x", 3)
			stub.tx = "release-tx"
			r, err := c.ReleaseDefinitiveFailure(ctx, "mandate", "reservation", evidence)
			if err != nil || r.Status != released {
				t.Fatalf("release: %+v %v", r, err)
			}
			stub.tx = "retry-release"
			r, err = c.ReleaseDefinitiveFailure(ctx, "mandate", "reservation", evidence)
			if err != nil || r.OutcomeTransactionID != "release-tx" {
				t.Fatal("release retry changed original transition")
			}
			m, err := c.QueryMandate(ctx, "mandate")
			if err != nil || m.ReservedPaise != 0 || m.SettledPaise != 0 || m.ActiveUsageCount != 0 {
				t.Fatalf("released counters: %+v %v", m, err)
			}
			if _, err = c.CommitOutcome(ctx, "mandate", "reservation", evidence); err == nil {
				t.Fatal("released payment settled")
			}
		})
	}
}

func TestLifecycleIdentityPermissionsAndProspectiveRevocation(t *testing.T) {
	c, ctx, stub := lifecycleFixture(t)
	ctx.SetClientIdentity(&testIdentity{msp: "Org1MSP", id: "unlisted-admin"})
	before := string(stub.state[mandateKey("mandate")])
	if _, err := c.QueryMandate(ctx, "mandate"); err == nil {
		t.Fatal("unlisted identity read mandate")
	}
	if _, err := c.QueryReservation(ctx, "mandate", "reservation"); err == nil {
		t.Fatal("unlisted identity read reservation")
	}
	if _, err := c.BeginDispatch(ctx, "mandate", "reservation"); err == nil {
		t.Fatal("unlisted identity dispatched")
	}
	if _, err := c.RevokeFutureAuthority(ctx, "mandate"); err == nil {
		t.Fatal("unlisted identity revoked")
	}
	if string(stub.state[mandateKey("mandate")]) != before {
		t.Fatal("denied calls mutated counters")
	}
	ctx.SetClientIdentity(&testIdentity{msp: "Org1MSP", id: "executor"})
	if _, err := c.BeginDispatch(ctx, "mandate", "reservation"); err != nil {
		t.Fatal(err)
	}
	ctx.SetClientIdentity(&testIdentity{msp: "Org1MSP", id: "owner"})
	stub.tx = "revoke-tx"
	m, err := c.RevokeFutureAuthority(ctx, "mandate")
	if err != nil || m.Status != revoked || m.ReservedPaise != 279900 {
		t.Fatalf("revoke: %+v %v", m, err)
	}
	stub.tx = "retry-revoke"
	m, err = c.RevokeFutureAuthority(ctx, "mandate")
	if err != nil || m.RevokedByTransactionID != "revoke-tx" {
		t.Fatal("revoke retry changed transaction")
	}
	ctx.SetClientIdentity(&testIdentity{msp: "VerifierMSP", id: "verifier"})
	if _, err = c.CommitOutcome(ctx, "mandate", "reservation", fmt.Sprintf("%064x", 4)); err != nil {
		t.Fatalf("revocation prevented resolution of existing dispatch: %v", err)
	}
}
