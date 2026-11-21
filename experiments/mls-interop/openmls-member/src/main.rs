// The OpenMLS member of the interoperability experiment (see ../interop.mjs): one member, driven
// line by line over stdin/stdout. Every answer ends with a line saying "end". Bytes travel as hex.
use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::io::{self, BufRead, Write};

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

struct Member {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    bundle: Option<KeyPackageBundle>,
    group: Option<MlsGroup>,
}

fn member(identity: &str) -> Member {
    let provider = OpenMlsRustCrypto::default();
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).expect("signature key");
    signer.store(provider.storage()).expect("store signer");
    let credential = CredentialWithKey {
        credential: BasicCredential::new(identity.as_bytes().to_vec()).into(),
        signature_key: signer.public().into(),
    };
    Member { provider, signer, credential, bundle: None, group: None }
}

fn describe(group: &MlsGroup) -> String {
    let names: Vec<String> = group
        .members()
        .map(|m| String::from_utf8_lossy(m.credential.serialized_content()).to_string())
        .collect();
    format!("epoch={} members={}", group.epoch().as_u64(), names.join(","))
}

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout();
    let mut me: Option<Member> = None;
    for line in stdin.lock().lines() {
        let line = line.expect("line");
        let (command, argument) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        let answer: String = match command {
            "kp" => {
                let mut m = member(argument);
                let bundle = KeyPackage::builder()
                    .build(SUITE, &m.provider, &m.signer, m.credential.clone())
                    .expect("key package");
                let bytes = MlsMessageOut::from(bundle.key_package().clone()).tls_serialize_detached().expect("serialize");
                m.bundle = Some(bundle);
                me = Some(m);
                format!("kp {}", hex::encode(bytes))
            }
            "create" => {
                let mut m = member(argument);
                let config = MlsGroupCreateConfig::builder().ciphersuite(SUITE).use_ratchet_tree_extension(true).build();
                m.group = Some(MlsGroup::new(&m.provider, &m.signer, &config, m.credential.clone()).expect("create group"));
                me = Some(m);
                "ok".into()
            }
            "add" => {
                let m = me.as_mut().expect("member");
                let bytes = hex::decode(argument).expect("hex");
                let key_package = match MlsMessageIn::tls_deserialize_exact(&bytes).expect("mls message").extract() {
                    MlsMessageBodyIn::KeyPackage(kp) => kp.validate(m.provider.crypto(), ProtocolVersion::Mls10).expect("valid key package"),
                    _ => panic!("expected a key package"),
                };
                let group = m.group.as_mut().expect("group");
                let (commit, welcome, _info) = group.add_members(&m.provider, &m.signer, &[key_package]).expect("add members");
                group.merge_pending_commit(&m.provider).expect("merge");
                format!(
                    "commit {}\nwelcome {}",
                    hex::encode(commit.tls_serialize_detached().expect("serialize")),
                    hex::encode(welcome.tls_serialize_detached().expect("serialize"))
                )
            }
            "join" => {
                let m = me.as_mut().expect("member");
                let bytes = hex::decode(argument).expect("hex");
                let welcome = match MlsMessageIn::tls_deserialize_exact(&bytes).expect("mls message").extract() {
                    MlsMessageBodyIn::Welcome(w) => w,
                    _ => panic!("expected a welcome"),
                };
                let config = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();
                match StagedWelcome::new_from_welcome(&m.provider, &config, welcome, None).and_then(|staged| staged.into_group(&m.provider)) {
                    Ok(group) => {
                        let text = format!("joined {}", describe(&group));
                        m.group = Some(group);
                        text
                    }
                    Err(err) => format!("error join: {err:?}"),
                }
            }
            "send" => {
                let m = me.as_mut().expect("member");
                let group = m.group.as_mut().expect("group");
                let message = group.create_message(&m.provider, &m.signer, argument.as_bytes()).expect("create message");
                format!("msg {}", hex::encode(message.tls_serialize_detached().expect("serialize")))
            }
            "recv" => {
                let m = me.as_mut().expect("member");
                let group = m.group.as_mut().expect("group");
                let bytes = hex::decode(argument).expect("hex");
                let parsed = MlsMessageIn::tls_deserialize_exact(&bytes).map_err(|e| format!("{e:?}")).and_then(|message| message.try_into_protocol_message().map_err(|e| format!("{e:?}")));
                match parsed.and_then(|protocol| group.process_message(&m.provider, protocol).map_err(|e| format!("{e:?}"))) {
                    Ok(processed) => match processed.into_content() {
                        ProcessedMessageContent::ApplicationMessage(app) => format!("app {}", String::from_utf8_lossy(&app.into_bytes())),
                        ProcessedMessageContent::StagedCommitMessage(staged) => {
                            group.merge_staged_commit(&m.provider, *staged).expect("merge staged commit");
                            format!("commit-merged {} active={}", describe(group), group.is_active())
                        }
                        ProcessedMessageContent::ProposalMessage(proposal) => {
                            group.store_pending_proposal(m.provider.storage(), *proposal).expect("store proposal");
                            "proposal".into()
                        }
                        _ => "other".into(),
                    },
                    Err(err) => format!("error recv: {err}"),
                }
            }
            "update" => {
                let m = me.as_mut().expect("member");
                let group = m.group.as_mut().expect("group");
                let (commit, _welcome, _info) = group.self_update(&m.provider, &m.signer, LeafNodeParameters::default()).expect("self update").into_contents();
                group.merge_pending_commit(&m.provider).expect("merge");
                format!("commit {}", hex::encode(commit.tls_serialize_detached().expect("serialize")))
            }
            "remove" => {
                let m = me.as_mut().expect("member");
                let group = m.group.as_mut().expect("group");
                let target = group
                    .members()
                    .find(|member| member.credential.serialized_content() == argument.as_bytes())
                    .expect("member to remove")
                    .index;
                let (commit, _welcome, _info) = group.remove_members(&m.provider, &m.signer, &[target]).expect("remove");
                group.merge_pending_commit(&m.provider).expect("merge");
                format!("commit {}", hex::encode(commit.tls_serialize_detached().expect("serialize")))
            }
            "state" => describe(me.as_ref().expect("member").group.as_ref().expect("group")),
            _ => "error unknown command".into(),
        };
        writeln!(out, "{answer}\nend").expect("write");
        out.flush().expect("flush");
    }
}
